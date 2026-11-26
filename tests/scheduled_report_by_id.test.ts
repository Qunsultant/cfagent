/**
 * Issue #339: getScheduledReportById — the store lookup behind
 * GET /api/reports/:id (Reports-tab research run detail). Owner scoping
 * follows the #584 EP-003 rule used by the list: strict when the caller
 * login is known, legacy unfiltered when it is not.
 *
 * Issue #6101 (step 8): the seam reads D1 agent_reports now — the DO
 * mas_reports table is frozen at cutover and receives no new writes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  storeReportAtGeneration,
  getScheduledReportById,
} from "../src/services/scheduledReports";

type D1Database = any;

function d1Env() {
  const mock = new MockD1Database();
  const env = { AGENT_DB: mock as unknown as D1Database, IAAA_TENANT_ID: "tenant-339" };
  return { mock, env };
}

function input(over: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    title: "Research run",
    source: "research_report",
    summary: "2 qualified ideas",
    body: { ideas: [] },
    userLogin: "alice",
    createdAt: "2026-10-19T12:00:00.000Z",
    ...over,
  } as any;
}

describe("getScheduledReportById", () => {
  let env: { AGENT_DB: D1Database; IAAA_TENANT_ID: string };
  let aliceId: string | null;
  let bobId: string | null;

  beforeEach(async () => {
    env = d1Env().env;
    // Persist via the canonical generation-time store (the path the
    // orchestrator uses): it records user_login, unlike the legacy raw
    // persistScheduledReportSql insert.
    aliceId = (await storeReportAtGeneration(input(), env))?.reportId ?? null;
    bobId =
      (await storeReportAtGeneration(
        input({ runId: "run-2", title: "Bob run", userLogin: "bob" }),
        env,
      ))?.reportId ?? null;
  });

  it("returns the stored report with its body", async () => {
    const hit = await getScheduledReportById(env, aliceId!);
    expect(hit).not.toBeNull();
    expect(hit!.title).toBe("Research run");
    expect(hit!.source).toBe("research_report");
    expect(JSON.parse(hit!.body)).toEqual({ ideas: [] });
  });

  it("returns null for an unknown id", async () => {
    expect(await getScheduledReportById(env, "nope")).toBeNull();
  });

  it("hides another owner's report when the caller login is known", async () => {
    expect(await getScheduledReportById(env, bobId!, { userLogin: "alice" })).toBeNull();
    expect(await getScheduledReportById(env, bobId!, { userLogin: "bob" })).not.toBeNull();
  });

  it("never throws on a broken store", async () => {
    const broken = {
      AGENT_DB: {
        prepare() {
          throw new Error("db gone");
        },
      } as unknown as D1Database,
    };
    expect(await getScheduledReportById(broken, "x")).toBeNull();
  });
});
