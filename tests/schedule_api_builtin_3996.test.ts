/**
 * Issue #3996 — jobsApi built-in goals client (moved from
 * scheduleApi, issue #3121 Phase 2 #3123):
 * listBuiltinGoals() reads the canonical definitions from the
 * server, and addBuiltinGoals() posts each missing goal in order,
 * reporting per-goal added / skipped / failed — never duplicating,
 * never failing wholesale, and seeding the disabled-by-design
 * goals as disabled.
 *
 * Red first: neither function exists yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listBuiltinGoals, addBuiltinGoals } from "../src/client/jobsApi";

const BUILTINS = [
  { id: "daily-qa-sweep", name: "Daily QA sweep", cron: "0 6 * * *", operation: "qa.run_sweep", budgetCents: 500, enabled: true },
  { id: "daily-social-post", name: "Daily social post", cron: "0 9 * * 1-5", operation: "social.publish", budgetCents: 1, enabled: false, timeZone: "America/New_York" },
  { id: "feed-refresh", name: "Feed refresh (all feed jobs)", cron: "0 * * * *", operation: "feed.refresh_all", budgetCents: 1, enabled: true, timeZone: "UTC" },
];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("jobsApi built-in goals (#3996)", () => {
  let posted: { path: string; body: any }[];
  let failIds: Map<string, string>;

  beforeEach(() => {
    posted = [];
    failIds = new Map();
    (globalThis as any).fetch = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/schedule/builtin-goals" && method === "GET") {
        return jsonResponse({ ok: true, goals: BUILTINS });
      }
      if (path === "/api/schedule/goals" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        posted.push({ path, body });
        const failure = failIds.get(body.id);
        if (failure) return jsonResponse({ ok: false, error: failure }, 400);
        return jsonResponse({ ok: true, goal: body });
      }
      return jsonResponse({ ok: false, error: "not found" }, 404);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listBuiltinGoals reads the server list, in server order", async () => {
    const { goals } = await listBuiltinGoals();
    expect(goals.map((g) => g.id)).toEqual(["daily-qa-sweep", "daily-social-post", "feed-refresh"]);
    expect(goals.find((g) => g.id === "daily-social-post")?.enabled).toBe(false);
  });

  it("addBuiltinGoals posts only the missing goals, in order, and skips existing ones without posting", async () => {
    const results = await addBuiltinGoals(BUILTINS, ["feed-refresh"]);
    expect(posted.map((p) => p.body.id)).toEqual(["daily-qa-sweep", "daily-social-post"]);
    expect(results).toEqual([
      { id: "daily-qa-sweep", status: "added" },
      { id: "daily-social-post", status: "added" },
      { id: "feed-refresh", status: "skipped", reason: "already exists" },
    ]);
  });

  it("addBuiltinGoals seeds the disabled-by-design goals as disabled", async () => {
    await addBuiltinGoals(BUILTINS, []);
    const social = posted.find((p) => p.body.id === "daily-social-post");
    expect(social?.body.enabled).toBe(false);
    expect(social?.body.timeZone).toBe("America/New_York");
    expect(posted.find((p) => p.body.id === "daily-qa-sweep")?.body.enabled).toBe(true);
  });

  it("addBuiltinGoals treats a server 'already exists' refusal as skipped, not failed", async () => {
    failIds.set("feed-refresh", "Goal already exists: feed-refresh");
    const results = await addBuiltinGoals(BUILTINS, []);
    expect(results).toEqual([
      { id: "daily-qa-sweep", status: "added" },
      { id: "daily-social-post", status: "added" },
      { id: "feed-refresh", status: "skipped", reason: "Goal already exists: feed-refresh" },
    ]);
  });

  it("addBuiltinGoals never fails wholesale: one bad goal is failed, the rest still post", async () => {
    failIds.set("daily-social-post", "Unknown operation: social.publish");
    const results = await addBuiltinGoals(BUILTINS, []);
    expect(posted.map((p) => p.body.id)).toEqual(["daily-qa-sweep", "daily-social-post", "feed-refresh"]);
    expect(results[1]).toEqual({ id: "daily-social-post", status: "failed", error: "Unknown operation: social.publish" });
    expect(results[0].status).toBe("added");
    expect(results[2].status).toBe("added");
    expect(new Set(posted.map((p) => p.body.id)).size).toBe(posted.length);
  });
});
