import { describe, expect, it, vi } from "vitest";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import {
  createTurnTools,
  type ChatTurnHelpersContext,
} from "../src/agents/orchestrator/chatTurnHelpers";
import type { Env } from "../src/types";
import { MockSqlStorage } from "./mock-sql";

/**
 * #6665 (G2, sub-issue of #3122): manage_agent_schedule is callable in
 * one round with its schema up front.
 *
 * The defect, observed live 2026-11-26: the prompt named the tool bare
 * while every neighbor is tool_openaimp_*, so the model called
 * tool_openaimp_manage_agent_schedule and got AI_NoSuchToolError; then,
 * once it reached the bare tool, it burned one round per hidden
 * constraint (kind "schedule", budgetCents 0, missing executionMode,
 * operation "none", flat goal shape) because the zod schema said
 * OPTIONAL / free-string where execute() throws. These pins assert the
 * fix: both names resolve to the same tool in the turn-assembled set,
 * the prompt steers to the tool_openaimp_* name with a schema summary,
 * and the schema itself refuses every previously-observed invalid
 * payload while accepting a complete valid create-goal payload.
 */

const VALID_CREATE_GOAL = {
  action: "create",
  kind: "goal",
  executionMode: "deterministic",
  goal: {
    id: "g1",
    name: "Daily rollup",
    cron: "0 9 * * *",
    operation: "resource.rollup_daily",
    budgetCents: 100,
  },
} as const;

function makeTurnTools() {
  const sql = new MockSqlStorage();
  const execute = vi.fn(async () => ({ ok: true as const }));
  const helpersCtx: ChatTurnHelpersContext = {
    env: { IAAA_TENANT_ID: "tenant-from-env" } as Env,
    ensureTables: () => sql as never,
    getOrm: () => ({}) as never,
    storage: { sql } as never,
    sessionKey: () => "session-6665",
    turnUserLogin: () => "test-login",
    agentScheduleExecute: execute as never,
    audit: () => {},
    submitAsyncJob: async () => {
      throw new Error("not used by the schedule tool drive");
    },
    getAsyncJob: () => undefined,
    listAsyncJobs: () => [],
    getMessages: async () => [],
    activeTurnMetadata: null,
  };
  return { tools: createTurnTools(helpersCtx, "req-6665"), execute };
}

describe("#6665 turn-assembled tool set", () => {
  it("contains BOTH names, aliased to the same tool object", () => {
    const { tools } = makeTurnTools();
    const bare = tools["manage_agent_schedule"];
    const prefixed = tools["tool_openaimp_manage_agent_schedule"];
    expect(bare).toBeDefined();
    expect(prefixed).toBeDefined();
    expect(prefixed).toBe(bare);
  });

  it("both names parse a complete valid create-goal payload in one round", () => {
    const { tools } = makeTurnTools();
    for (const name of ["manage_agent_schedule", "tool_openaimp_manage_agent_schedule"]) {
      const parsed = tools[name].inputSchema.safeParse(VALID_CREATE_GOAL);
      expect(parsed.success, `${name} should parse the valid create-goal payload`).toBe(true);
    }
  });

  it("both names execute a valid create-goal payload through the alias", async () => {
    const { tools, execute } = makeTurnTools();
    await tools["tool_openaimp_manage_agent_schedule"].execute(VALID_CREATE_GOAL);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create",
        kind: "goal",
        operation: "resource.rollup_daily",
      }),
    );
  });

  it("the tool description names both callable names", () => {
    const { tools } = makeTurnTools();
    const description = tools["manage_agent_schedule"].description as string;
    expect(description).toContain("tool_openaimp_manage_agent_schedule");
    expect(description).toContain("manage_agent_schedule");
    expect(description).toContain("NESTED goal");
  });
});

describe("#6665 schema refuses the previously-observed invalid payloads", () => {
  const cases: Array<{ label: string; payload: unknown }> = [
    {
      label: 'kind "schedule" is not a valid kind',
      payload: { ...VALID_CREATE_GOAL, kind: "schedule" },
    },
    {
      label: "goal budgetCents 0 is not positive",
      payload: {
        ...VALID_CREATE_GOAL,
        goal: { ...VALID_CREATE_GOAL.goal, budgetCents: 0 },
      },
    },
    {
      label: "create without executionMode",
      payload: (() => {
        const { executionMode: _omitted, ...rest } = VALID_CREATE_GOAL;
        return rest;
      })(),
    },
    {
      label: 'goal operation "none" is not schedulable',
      payload: {
        ...VALID_CREATE_GOAL,
        goal: { ...VALID_CREATE_GOAL.goal, operation: "none" },
      },
    },
    {
      label: "flat shape without the nested goal object",
      payload: {
        action: "create",
        kind: "goal",
        executionMode: "deterministic",
        id: "g1",
        name: "Daily rollup",
        cron: "0 9 * * *",
        operation: "resource.rollup_daily",
        budgetCents: 100,
      },
    },
    {
      label: "pause without scheduleId",
      payload: { action: "pause", kind: "goal" },
    },
  ];

  for (const { label, payload } of cases) {
    it(label, () => {
      const { tools } = makeTurnTools();
      for (const name of ["manage_agent_schedule", "tool_openaimp_manage_agent_schedule"]) {
        const parsed = tools[name].inputSchema.safeParse(payload);
        expect(parsed.success, `${name} should refuse: ${label}`).toBe(false);
      }
    });
  }
});

describe("#6665 prompt steering", () => {
  it("names tool_openaimp_manage_agent_schedule with a schema summary", () => {
    const prompt = buildOrchestratorSystemPrompt({
      route: { agent: "orchestrator", confidence: 1, reason: "test" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
    expect(prompt).toContain("'tool_openaimp_manage_agent_schedule'");
    expect(prompt).not.toContain("\n- 'manage_agent_schedule':");
    expect(prompt).toContain("NESTED goal");
    expect(prompt).toContain("executionMode");
    expect(prompt).toContain("budgetCents > 0");
  });
});
