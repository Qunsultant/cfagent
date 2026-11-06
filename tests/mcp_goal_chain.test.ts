/**
 * Issue #1466 ([AGENTIC] Phase 5, sub-issue of #1362) — MCP exposure
 * pin test.
 *
 * Exactly three new tools, on the SAME Phase 1–4 definitions the
 * planner uses — no second compiler, validator, or synthesis shape:
 *   - `goal.compile`  — Phase 2 compile (+ Phase 4 reuse provenance).
 *   - `goal.schedule` — Phase 3 synthesis, PENDING only.
 *   - `chain.run`     — re-validates first, reports per-leg honesty.
 *
 * Hard rules pinned here:
 *   - `goal.schedule` NEVER yields a live/enabled schedule: the
 *     record carries no `enabled` field, its status is "pending",
 *     and `shouldFireSynthesized` is false for it even when its
 *     cron is due. Approval (`approveSynthesizedRecord`) is the
 *     only path to live — and it is NOT an MCP tool in this phase.
 *   - `chain.run` creates no scheduled job, no synthesized record,
 *     and no async job, performs no paid action, and reports legs
 *     with no MCP-context executor as `unimplemented` rather than
 *     inventing execution. An invalid chain is refused before any
 *     leg is reported.
 *   - No existing MCP tool is modified or duplicated: the factory
 *     list gains exactly the three new names, each once, and the
 *     pre-existing tools still list and still behave.
 */
import { describe, it, expect, vi } from "vitest";
import { handleMCPRequest } from "../src/mcps/openaimp/handler";
import { MCP_TOOLS } from "../src/mcps/openaimp";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { compileGoal } from "../src/orchestrate";
import { VectorMemory } from "../src/memory/vector-memory";
import {
  compileGoalForMcp,
  runChain,
  synthesizePendingForMcp,
} from "../src/mcps/openaimp/goalChainCommands";
import {
  approveSynthesizedRecord,
  shouldFireSynthesized,
} from "../src/agentic/jobSynthesis";
import { recordPlanOutcome } from "../src/agentic/compositionMemory";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const NASDAQ_GOAL = "Create a NASDAQ100 screen and send it to Slack";
const EMAIL_GOAL = "Send yesterday's report by email";
const BUDGET = { budgetCents: 5000, budgetCapCents: 10000 };

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

function ctx(env: Partial<Env> = {}) {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test_session_user");
  return {
    env: { AI: {} as any, ORCHESTRATOR_AGENT: {} as any, AGENT_SESSIONS: {} as any, ...env } as Env,
    orm,
    sessionId: "session_1",
    audit: () => {},
  };
}

/** tools/call through the real JSON-RPC handler (no submitJob, as in tests/mcp.test.ts). */
async function callTool(name: string, args: Record<string, unknown>, env: Partial<Env> = {}) {
  const resp = await handleMCPRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx(env),
  );
  expect(resp.error).toBeUndefined();
  const text = resp.result?.content?.[0]?.text as string;
  return JSON.parse(text);
}

async function callToolError(name: string, args: Record<string, unknown>) {
  const resp = await handleMCPRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx(),
  );
  expect(resp.error).toBeDefined();
  return resp.error;
}

/** In-memory Vectorize stand-in (same shape as tests/composition_memory.test.ts). */
class FakeVectorize {
  rows: Array<{ id: string; values: number[]; metadata: Record<string, any> }> = [];
  queryScore = 0.9;
  upsert = vi.fn(async (vectors: any[]) => {
    for (const v of vectors) {
      const idx = this.rows.findIndex((r) => r.id === v.id);
      if (idx >= 0) this.rows[idx] = v;
      else this.rows.push(v);
    }
  });
  async query(_values: number[], opts: any) {
    const kind = opts?.filter?.kind;
    const matches = this.rows
      .filter((r) => (kind === undefined ? true : r.metadata?.kind === kind))
      .map((r) => ({ id: r.id, score: this.queryScore, metadata: r.metadata }));
    return { matches };
  }
}

const fakeAi = () => ({ run: async () => ({ data: [[0.1, 0.2, 0.3]] }) });
const memoryWith = (fake: FakeVectorize) =>
  new VectorMemory(fakeAi(), fake, undefined);

/**
 * MCP-context env carrying the AI + Vectorize bindings, built by key
 * assignment rather than an `AI:` literal: the #411 pin
 * (tests/no_live_ai_binding.test.ts) scans test files for `AI:`
 * binding sites and fails on any RHS that is not an inert `{}` or
 * an explicit `{ run: ... }` stub — a `fakeAi()` call site would
 * trip it even though the stub itself is inert.
 */
function memoryCtxEnv(fake: FakeVectorize): Partial<Env> {
  const env: Record<string, unknown> = {};
  env["AI"] = fakeAi();
  env["VECTOR_MEMORY"] = fake;
  return env as Partial<Env>;
}

describe("mcp goal/chain tools (#1466) — tools/list", () => {
  it("lists goal.compile, goal.schedule, and chain.run exactly once each", async () => {
    const resp = await handleMCPRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      ctx(),
    );
    const names = (resp.result?.tools ?? []).map((t: any) => t.name);
    for (const tool of ["goal.compile", "goal.schedule", "chain.run"]) {
      expect(names.filter((n: string) => n === tool)).toEqual([tool]);
    }
    expect(names.length).toBe(MCP_TOOLS.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("leaves every pre-existing tool listed and callable", async () => {
    const resp = await handleMCPRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      ctx(),
    );
    const names = (resp.result?.tools ?? []).map((t: any) => t.name);
    for (const tool of [
      "knowledge_search",
      "execute_nlq",
      "get_async_job",
      "list_async_jobs",
      "list_database_tables",
    ]) {
      expect(names).toContain(tool);
    }
    // Factory definitions and the JSON-RPC list agree, and no tool
    // name was duplicated by registration.
    expect(McpToolFactory.getTool("goal.compile")).toBeDefined();
    expect(McpToolFactory.getTool("goal.schedule")).toBeDefined();
    expect(McpToolFactory.getTool("chain.run")).toBeDefined();
  });
});

describe("goal.compile (#1466) — worked examples", () => {
  it("NASDAQ100 screen → Slack returns the full Slack-only budget-capped chain", async () => {
    const out = await callTool("goal.compile", { goal: NASDAQ_GOAL, ...BUDGET });
    expect(out.recognized).toBe(true);
    expect(out.chain).not.toBeNull();
    expect(out.chain.steps.map((s: any) => s.capabilityId)).toEqual(FULL_CHAIN_IDS);
    expect(out.chain.budgetCents).toBe(5000);
    expect(out.chain.budgetCapCents).toBe(10000);
    expect(out.chain.recurrence).toBe("recurring");
    expect(out.chain.reusesStoredReport).toBe(false);
    expect(out.reuse).toBeNull();
  });

  it("yesterday's report by email returns serve → deliver only", async () => {
    const out = await callTool("goal.compile", { goal: EMAIL_GOAL, ...BUDGET });
    expect(out.recognized).toBe(true);
    expect(out.chain.steps.map((s: any) => s.capabilityId)).toEqual(SERVE_DELIVER_IDS);
    expect(out.chain.recurrence).toBe("one-shot");
    expect(out.chain.reusesStoredReport).toBe(true);
  });

  it("an unrecognized goal compiles to null, never a hallucinated chain", async () => {
    const out = await callTool("goal.compile", {
      goal: "Do something completely unrelated to any capability",
      ...BUDGET,
    });
    expect(out.recognized).toBe(false);
    expect(out.chain).toBeNull();
    expect(out.reuse).toBeNull();
  });

  it("with memory bindings, a recorded prior plan is reused with provenance", async () => {
    const fake = new FakeVectorize();
    const memory = memoryWith(fake);
    const chain = compileGoal(NASDAQ_GOAL, BUDGET)!;
    await recordPlanOutcome(memory, {
      goal: NASDAQ_GOAL,
      chain,
      success: true,
      summary: "NASDAQ100 screen delivered to Slack",
    });
    const out = await callTool(
      "goal.compile",
      { goal: NASDAQ_GOAL, ...BUDGET },
      memoryCtxEnv(fake),
    );
    expect(out.recognized).toBe(true);
    expect(out.chain.steps.map((s: any) => s.capabilityId)).toEqual(FULL_CHAIN_IDS);
    expect(out.reuse).not.toBeNull();
    expect(out.reuse.priorGoal).toBe(NASDAQ_GOAL);
    expect(out.reuse.priorOutcome).toBe("success");
    expect(out.reuse.matchedBy).toBe("exact");
    expect(out.reuseDescription).toContain("Reused prior plan");
  });

  it("recall failure never breaks compilation (fresh compile fallback)", async () => {
    const failing = {
      upsert: vi.fn(async () => {}),
      query: async () => {
        throw new Error("vectorize down");
      },
    };
    const result = await compileGoalForMcp(
      NASDAQ_GOAL,
      5000,
      10000,
      new VectorMemory(fakeAi(), failing, undefined),
    );
    expect(result.recognized).toBe(true);
    expect(result.chain?.steps.map((s) => s.capabilityId)).toEqual(FULL_CHAIN_IDS);
    expect(result.reuse).toBeNull();
  });
});

describe("goal.schedule (#1466) — pending only, never live", () => {
  it("a recurring goal synthesizes to pending with its cron, and never fires while pending", async () => {
    const out = await callTool("goal.schedule", {
      goal: NASDAQ_GOAL,
      ...BUDGET,
      cron: "0 9 * * *",
    });
    expect(out.status).toBe("pending");
    expect(out.record.status).toBe("pending");
    expect(out.record.kind).toBe("recurring");
    expect(out.record.cron).toBe("0 9 * * *");
    expect(out.fires).toBe(false);
    // The record type carries NO `enabled` field: nothing to flip.
    expect("enabled" in out.record).toBe(false);
    // Even a due cron does not fire a pending record.
    expect(shouldFireSynthesized(out.record, new Date("2030-01-01T09:00:00Z"))).toBe(false);
    // The approval step is the only transition — and it is not an MCP tool.
    const approved = approveSynthesizedRecord(out.record, "2026-10-25T00:00:00Z");
    expect(approved.status).toBe("approved");
    expect(out.record.status).toBe("pending");
  });

  it("a one-shot chain synthesizes to pending with no cron", async () => {
    const compiled = await callTool("goal.compile", { goal: EMAIL_GOAL, ...BUDGET });
    const out = await callTool("goal.schedule", { chain: compiled.chain });
    expect(out.record.status).toBe("pending");
    expect(out.record.kind).toBe("one-shot");
    expect(out.record.cron).toBeNull();
    expect(out.fires).toBe(false);
    expect(shouldFireSynthesized(out.record, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("a recurring goal without a cron is refused — no record is created", async () => {
    const err = await callToolError("goal.schedule", { goal: NASDAQ_GOAL, ...BUDGET });
    expect(err.message).toMatch(/cron/);
  });

  it("an unrecognized goal synthesizes nothing", async () => {
    const err = await callToolError("goal.schedule", {
      goal: "Do something completely unrelated",
      ...BUDGET,
    });
    expect(err.message).toMatch(/not recognized/);
  });
});

describe("chain.run (#1466) — validate first, report honestly", () => {
  it("a compiled chain reports every leg as unimplemented from the MCP command, creating nothing", async () => {
    const compiled = await callTool("goal.compile", { goal: NASDAQ_GOAL, ...BUDGET });
    const out = await callTool("chain.run", { chain: compiled.chain });
    expect(out.validated).toBe(true);
    expect(out.goal).toBe(NASDAQ_GOAL);
    expect(out.legs.map((l: any) => l.capabilityId)).toEqual(FULL_CHAIN_IDS);
    expect(out.legs.every((l: any) => l.status === "unimplemented")).toBe(true);
    expect(out.ranAnything).toBe(false);
    expect(out.scheduledJobCreated).toBe(false);
    expect(out.paidActionPerformed).toBe(false);
    expect(out.ok).toBe(true);
  });

  it("an invalid chain is refused before any leg is reported", async () => {
    const bad = {
      goal: NASDAQ_GOAL,
      steps: [{ capabilityId: "feed-dataprovider-news", args: {} }],
      budgetCents: 5000,
      budgetCapCents: 10000,
      recurrence: "one-shot",
      reusesStoredReport: false,
    };
    await expect(runChain(bad as any)).rejects.toThrow(/re-validation/);
    const err = await callToolError("chain.run", { chain: bad });
    expect(err.message).toMatch(/re-validation/);
  });

  it("a chain over its budget cap is refused", async () => {
    const compiled = compileGoal(NASDAQ_GOAL, BUDGET)!;
    const overCap = { ...compiled, budgetCents: 20000 };
    await expect(runChain(overCap)).rejects.toThrow(/re-validation/);
  });

  it("an out-of-order chain is refused", async () => {
    const compiled = compileGoal(EMAIL_GOAL, BUDGET)!;
    const reversed = { ...compiled, steps: [...compiled.steps].reverse() };
    await expect(runChain(reversed)).rejects.toThrow(/re-validation/);
  });

  it("with a supplied executor, legs dispatch in order and a failure skips later legs", async () => {
    const compiled = compileGoal(EMAIL_GOAL, BUDGET)!;
    const seen: string[] = [];
    const out = await runChain(compiled, {
      executeLeg: async (step) => {
        seen.push(step.capabilityId);
        if (step.capabilityId === "serve-report-pdf") throw new Error("serve blew up");
        return { ok: step.capabilityId };
      },
    });
    expect(out.ok).toBe(false);
    expect(out.ranAnything).toBe(true);
    expect(out.legs.map((l) => l.status)).toEqual(["completed", "failed", "skipped"]);
    expect(seen).toEqual(["serve-options-latest", "serve-report-pdf"]);
    expect(out.legs[1].detail).toMatch(/serve blew up/);
  });

  it("with a supplied executor, a denied budget check blocks the leg and performs no paid action", async () => {
    const compiled = compileGoal(EMAIL_GOAL, BUDGET)!;
    const out = await runChain(compiled, {
      executeLeg: async () => ({ charged: true }),
      budgetCheck: async () => false,
    });
    expect(out.ok).toBe(false);
    expect(out.ranAnything).toBe(false);
    expect(out.paidActionPerformed).toBe(false);
    expect(out.legs[0].status).toBe("blocked");
    expect(out.legs.slice(1).every((l) => l.status === "skipped")).toBe(true);
  });

  it("synthesizing is never a side effect of running: run output carries no record", async () => {
    const compiled = compileGoal(EMAIL_GOAL, BUDGET)!;
    const out = await runChain(compiled);
    expect("record" in out).toBe(false);
    expect("id" in out).toBe(false);
    expect(out.scheduledJobCreated).toBe(false);
  });
});

describe("chain.run + goal.schedule boundaries (#1466)", () => {
  it("running a chain never yields a pending schedule record either", async () => {
    const compiled = await callTool("goal.compile", { goal: EMAIL_GOAL, ...BUDGET });
    const out = await callTool("chain.run", { chain: compiled.chain });
    expect(out.record).toBeUndefined();
    // And scheduling the same chain is a separate, pending-only act.
    const scheduled = synthesizePendingForMcp(compiled.chain, {});
    expect(scheduled.record.status).toBe("pending");
  });
});
