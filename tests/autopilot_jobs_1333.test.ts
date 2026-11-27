/**
 * Issue #1333: GET /autopilot/jobs serves the job-outcome sink —
 * the feed Autopilot Control renders, newest first, labeled by
 * origin. #6101: the DO sink is gone — the feed reads the folded
 * outcome facts on the D1 run records, so the tests seed through
 * the D1 fold (the same shape the producers fold), not the DO sink.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { handleAutopilotRoutes } from "../src/agents/routes/autopilot";
import { MockD1Database } from "./mock-d1";
import { createJobRunRecordAdapter } from "../src/data/createJobRunRecordPorts";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";

describe("GET /autopilot/jobs (#1333)", () => {
  // #6101: seed through the D1 fold — the route reads D1, and the
  // DO recordJobOutcome sink no longer feeds it.
  async function seedOutcome(d1: MockD1Database, input: Record<string, unknown>) {
    const env = { AGENT_DB: d1 };
    const store = createJobRunRecordAdapter(env as never);
    await store!.foldJobOutcome(
      input as never,
      resolveIaaaTenant(env as never),
      Date.now(),
    );
  }

  it("returns recorded outcomes newest first", async () => {
    const sql = new MockSqlStorage();
    const d1 = new MockD1Database();
    await seedOutcome(d1, {
      id: "auth-fail",
      kind: "options",
      trigger: "scheduled",
      status: "failed",
      codedError: "[FAILURE_AUTH_NO_SESSION] E*TRADE connection missing",
      origin: "job-tree",
      createdAt: "2026-10-24T04:58:00.000Z",
    });
    await seedOutcome(d1, {
      id: "goal-zero",
      kind: "goal",
      trigger: "manual",
      status: "completed",
      scanned: 6604,
      matched: 0,
      origin: "job-tree",
      createdAt: "2026-10-24T10:36:00.000Z",
    });
    const ctx = {
      ensureTables: () => sql,
      env: { AGENT_DB: d1 },
      audit: () => {},
      getAutopilotState: () => ({}),
      writeAutopilotState: (p: any) => p,
      evaluateAndRecordAutopilotVerdict: async () => ({}),
    } as any;
    const res = await handleAutopilotRoutes(
      new Request("https://agent.internal/api/autopilot/jobs", { method: "GET" }),
      new URL("https://agent.internal/api/autopilot/jobs"),
      "/api/autopilot/jobs",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    const data = (await res!.json()) as any;
    expect(data.count).toBe(2);
    expect(data.jobs[0].id).toBe("goal-zero");
    expect(data.jobs[1].codedError).toContain("[FAILURE_AUTH_NO_SESSION]");
  });

  it("honors the limit parameter", async () => {
    const sql = new MockSqlStorage();
    const d1 = new MockD1Database();
    for (let i = 0; i < 3; i++) {
      await seedOutcome(d1, {
        id: `job-${i}`,
        kind: "stock",
        trigger: "scheduled",
        status: "completed",
        origin: "job-tree",
        createdAt: `2026-10-24T0${i}:00:00.000Z`,
      });
    }
    const ctx = { ensureTables: () => sql, env: { AGENT_DB: d1 }, audit: () => {} } as any;
    const res = await handleAutopilotRoutes(
      new Request("https://agent.internal/api/autopilot/jobs?limit=2", { method: "GET" }),
      new URL("https://agent.internal/api/autopilot/jobs?limit=2"),
      "/api/autopilot/jobs",
      "s",
      ctx
    );
    const data = (await res!.json()) as any;
    expect(data.jobs).toHaveLength(2);
  });
});
