import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// Same worker-fetch harness pattern as tests/api_me_internal_user_id.test.ts.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import type { Env } from "../src/types";
import { zonedDateParts } from "../src/schedule";
import { SOCIAL_BRIEF_MAX_CHARS } from "../src/agents/social/briefStore";

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-312000000009";

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: "octocat-brief" });
  return { SESSION_STORE: sessionStoreNs } as unknown as Env;
}

const todayNY = () => zonedDateParts(Date.now(), "America/New_York").date;

/**
 * Calendar-day arithmetic on a YYYY-MM-DD string (UTC-based, so DST
 * never shifts the result). Used so the "explicit date" test below
 * always picks a date that is NOT today: a hardcoded explicit date
 * eventually becomes today and the test's "today stays null"
 * assertion fails on that day (observed 2026-10-27, when the
 * hardcoded date collided with today).
 */
const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

function req(method: string, body?: unknown, cookie?: string, path = "/api/social/brief") {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("social brief routes (#1077 Phase 5b slice 2)", () => {
  it("unauthenticated GET and POST → 401", async () => {
    const env = makeEnv();
    expect((await worker.fetch(req("GET"), env)).status).toBe(401);
    expect((await worker.fetch(req("POST", { text: "x" }), env)).status).toBe(401);
  });

  it("GET with no stored brief → ok, today NY date, brief null", async () => {
    const res = await worker.fetch(req("GET", undefined, SESSION_ID), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, date: todayNY(), brief: null });
  });

  it("POST then GET round-trips, defaulting to today NY", async () => {
    const env = makeEnv();
    const post = await worker.fetch(req("POST", { text: "Human brief." }, SESSION_ID), env);
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true, date: todayNY() });
    const get = await worker.fetch(req("GET", undefined, SESSION_ID), env);
    expect(await get.json()).toEqual({ ok: true, date: todayNY(), brief: "Human brief." });
  });

  it("explicit date stores under that date only; overwrite wins", async () => {
    const env = makeEnv();
    // The explicit date must differ from today by construction (see
    // addDays above): a hardcoded date eventually IS today.
    const explicit = addDays(todayNY(), 1);
    await worker.fetch(req("POST", { text: "Dated brief.", date: explicit }, SESSION_ID), env);
    await worker.fetch(req("POST", { text: "Replaced.", date: explicit }, SESSION_ID), env);
    const dated = await worker.fetch(req("GET", undefined, SESSION_ID, `/api/social/brief?date=${explicit}`), env);
    expect(await dated.json()).toEqual({ ok: true, date: explicit, brief: "Replaced." });
    const today = await worker.fetch(req("GET", undefined, SESSION_ID), env);
    expect((await today.json() as Record<string, unknown>).brief).toBeNull();
  });

  it("POST rejects empty, whitespace, non-string, bad-JSON, and bad-date bodies with 400", async () => {
    const env = makeEnv();
    for (const bad of [
      { text: "" },
      { text: "   " },
      { text: 42 },
      { text: "x", date: "27-10-2026" },
      { text: "x", date: "2026-13-01" },
    ]) {
      const res = await worker.fetch(req("POST", bad, SESSION_ID), env);
      expect(res.status).toBe(400);
    }
    const badJson = await worker.fetch(req("POST", "{not json", SESSION_ID), env);
    expect(badJson.status).toBe(400);
    const missing = await worker.fetch(req("POST", {}, SESSION_ID), env);
    expect(missing.status).toBe(400);
  });

  it("POST rejects over-long text with 413 and accepts exactly the cap", async () => {
    const env = makeEnv();
    const over = await worker.fetch(
      req("POST", { text: "x".repeat(SOCIAL_BRIEF_MAX_CHARS + 1) }, SESSION_ID),
      env,
    );
    expect(over.status).toBe(413);
    const atCap = await worker.fetch(
      req("POST", { text: "x".repeat(SOCIAL_BRIEF_MAX_CHARS) }, SESSION_ID),
      env,
    );
    expect(atCap.status).toBe(200);
  });

  it("other methods → 405", async () => {
    const res = await worker.fetch(req("PUT", { text: "x" }, SESSION_ID), makeEnv());
    expect(res.status).toBe(405);
  });
});
