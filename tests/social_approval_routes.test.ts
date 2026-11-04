/**
 * #1077 Phase 5b slice 3: social approval routes + Slack interaction routing.
 *
 * Pinned here (worker.fetch harness, same pattern as the brief routes):
 * - POST /api/social/approval and GET /api/social/approvals are
 *   session-gated (401 unauthenticated), like the brief routes;
 * - route approve publishes promptly (dry-run) and reports the outcome;
 *   route reject publishes nothing;
 * - missing draft → 404, already-posted/rejected → 409, bad input → 400;
 * - GET /api/social/approvals lists pending with draft text for review;
 * - POST /slack/interactions with a valid signature routes social
 *   actions to the social handler (replacement blocks, draft posted)
 *   WITHOUT touching the trading forward path;
 * - bad signature → 401, missing signing secret → 503 (the #147 gate,
 *   unchanged by this slice).
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeFakeSessionStore } from "./fake-session-store";

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

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-312000000009";
const DATE = "2026-10-26";

function makeEnv(extra: Record<string, unknown> = {}) {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: "octocat-approval" });
  const env = {
    SESSION_STORE: sessionStoreNs,
    SOCIAL_POSTING_ENABLED: "1",
    SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
    SOCIAL_APPROVAL_CHANNELS: "facebook,instagram,linkedin",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ...extra,
  } as unknown as Env;
  // Test-only handle: seed social records through the same fake
  // store the server-side durable stores read. Never read by server
  // code (unknown env keys are ignored).
  (env as unknown as Record<string, unknown>).__seedSocial = seedSession;
  return env;
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
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

function seedDraft(env: Env, draft: Record<string, unknown>, pending = true) {
  const seed = (env as unknown as Record<string, (ns: string, key: string, v: unknown) => void>).__seedSocial;
  seed("social", `social-draft:${DATE}:${draft.channel}`, draft);
  if (pending) {
    seed("social", `social-pending:${DATE}:${draft.channel}`, {
      date: DATE,
      channel: draft.channel,
      draftId: draft.id,
      requestedAtMs: 1_000,
    });
  }
}

const DRAFT = {
  id: "draft-1",
  date: DATE,
  channel: "facebook",
  text: "Morning brief: markets up.",
  status: "draft",
  createdAtMs: 1_000,
  originalLength: 26,
  truncated: false,
};

function slackReq(payload: unknown, secret = "test-signing-secret", timestamp?: string) {
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig =
    "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
  return new Request("https://agent.test/slack/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": sig,
    },
    body: rawBody,
  });
}

describe("social approval routes (#1077 Phase 5b slice 3)", () => {
  it("unauthenticated approval POST and approvals GET → 401", async () => {
    const env = makeEnv();
    expect(
      (await worker.fetch(req("POST", "/api/social/approval", { date: DATE, channel: "facebook", action: "approve" }), env)).status,
    ).toBe(401);
    expect((await worker.fetch(req("GET", "/api/social/approvals"), env)).status).toBe(401);
  });

  it("route approve publishes (dry-run) and reports the outcome", async () => {
    const env = makeEnv();
    seedDraft(env, DRAFT);
    const res = await worker.fetch(
      req("POST", "/api/social/approval", { date: DATE, channel: "facebook", action: "approve" }, SESSION_ID),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.approved).toBe(true);
    expect(body.publish?.outcome).toBe("posted");
    const list = await worker.fetch(req("GET", `/api/social/approvals?date=${DATE}`, undefined, SESSION_ID), env);
    expect(((await list.json()) as any).approvals).toHaveLength(0);
  });

  it("route reject publishes nothing and the draft reads failed", async () => {
    const env = makeEnv();
    seedDraft(env, DRAFT);
    const res = await worker.fetch(
      req("POST", "/api/social/approval", { date: DATE, channel: "facebook", action: "reject" }, SESSION_ID),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).rejected).toBe(true);
    const list = await worker.fetch(req("GET", `/api/social/approvals?date=${DATE}`, undefined, SESSION_ID), env);
    expect(((await list.json()) as any).approvals).toHaveLength(0);
  });

  it("missing draft → 404, already-posted → 409, bad input → 400", async () => {
    const env = makeEnv();
    const missing = await worker.fetch(
      req("POST", "/api/social/approval", { date: DATE, channel: "facebook", action: "approve" }, SESSION_ID),
      env,
    );
    expect(missing.status).toBe(404);
    seedDraft(env, { ...DRAFT, status: "posted" }, false);
    const posted = await worker.fetch(
      req("POST", "/api/social/approval", { date: DATE, channel: "facebook", action: "approve" }, SESSION_ID),
      env,
    );
    expect(posted.status).toBe(409);
    for (const bad of [
      { date: DATE, channel: "facebook" },
      { date: DATE, channel: "facebook", action: "maybe" },
      { date: DATE, channel: "myspace", action: "approve" },
      { date: "27-10-2026", channel: "facebook", action: "approve" },
    ]) {
      const res = await worker.fetch(req("POST", "/api/social/approval", bad, SESSION_ID), env);
      expect(res.status).toBe(400);
    }
  });

  it("GET approvals lists pending with draft text", async () => {
    const env = makeEnv();
    seedDraft(env, DRAFT);
    const res = await worker.fetch(req("GET", `/api/social/approvals?date=${DATE}`, undefined, SESSION_ID), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.date).toBe(DATE);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      channel: "facebook",
      draftId: "draft-1",
      text: "Morning brief: markets up.",
    });
  });

  it("other methods on the approval routes → 405", async () => {
    const env = makeEnv();
    expect((await worker.fetch(req("PUT", "/api/social/approval", {}, SESSION_ID), env)).status).toBe(405);
    expect((await worker.fetch(req("POST", "/api/social/approvals", {}, SESSION_ID), env)).status).toBe(405);
  });
});

describe("Slack interaction routing for social approvals", () => {
  it("valid signature + social approve → replacement blocks, draft posted, pending cleared", async () => {
    const env = makeEnv();
    seedDraft(env, DRAFT);
    // Issue #1262 Phase 2: a social APPROVE requires a resolved
    // principal — seed the clicker's link (team T1, user U1) through
    // the same fake store the server-side link store reads.
    const seed = (env as unknown as Record<string, (ns: string, key: string, v: unknown) => void>).__seedSocial;
    seed("slack_principal_links", "link:T1:U1", {
      login: "approver-login",
      tier: "trade",
      linkedAt: new Date().toISOString(),
    });
    const res = await worker.fetch(
      slackReq({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1", username: "approver" },
        channel: { id: "C-general" },
        actions: [{ action_id: "social_approve", value: `${DATE}|facebook|draft-1` }],
      }, "test-signing-secret"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.replace_original).toBe(true);
    expect(body.text).toContain("APPROVED");
    const list = await worker.fetch(req("GET", `/api/social/approvals?date=${DATE}`, undefined, SESSION_ID), env);
    expect(((await list.json()) as any).approvals).toHaveLength(0);
  });

  it("bad signature → 401, missing signing secret → 503 (gate unchanged)", async () => {
    const env = makeEnv();
    const bad = await worker.fetch(
      slackReq(
        {
          type: "block_actions",
          user: { id: "U1" },
          actions: [{ action_id: "social_approve", value: `${DATE}|facebook|draft-1` }],
        },
        "wrong-secret",
      ),
      env,
    );
    expect(bad.status).toBe(401);
    const noSecret = makeEnv({ SLACK_SIGNING_SECRET: undefined });
    const res = await worker.fetch(
      slackReq(
        {
          type: "block_actions",
          user: { id: "U1" },
          actions: [{ action_id: "social_approve", value: `${DATE}|facebook|draft-1` }],
        },
        "test-signing-secret",
      ),
      noSecret,
    );
    // The env without a secret must fail closed at the gate.
    expect(res.status).toBe(503);
  });

  describe("GET /api/social/posts (#1391)", () => {
    it("requires authentication → 401", async () => {
      const env = makeEnv();
      const res = await worker.fetch(req("GET", `/api/social/posts?date=${DATE}`), env);
      expect(res.status).toBe(401);
    });

    it("refuses non-GET methods → 405", async () => {
      const env = makeEnv();
      const res = await worker.fetch(req("POST", "/api/social/posts", {}, SESSION_ID), env);
      expect(res.status).toBe(405);
    });

    it("validates date format → 400 for bad dates", async () => {
      const env = makeEnv();
      const res = await worker.fetch(req("GET", "/api/social/posts?date=not-a-date", undefined, SESSION_ID), env);
      expect(res.status).toBe(400);
    });

    it("returns posts for date with submissionEndpoint and postUrl", async () => {
      const env = makeEnv();
      seedDraft(
        env,
        {
          id: "draft-th-live",
          date: DATE,
          channel: "threads",
          text: "Live post from automated pipeline",
          status: "posted",
          platformPostId: "post_th_888",
          createdAtMs: 1_000,
          originalLength: 33,
          truncated: false,
        },
        false,
      );
      seedDraft(
        env,
        {
          id: "draft-x-dry",
          date: DATE,
          channel: "x",
          text: "Dry run post",
          status: "dry-run-posted",
          createdAtMs: 1_000,
          originalLength: 12,
          truncated: false,
        },
        false,
      );

      const res = await worker.fetch(req("GET", `/api/social/posts?date=${DATE}`, undefined, SESSION_ID), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.date).toBe(DATE);
      expect(body.posts.length).toBeGreaterThanOrEqual(2);

      const th = body.posts.find((p: any) => p.channel === "threads");
      expect(th).toBeDefined();
      expect(th.status).toBe("posted");
      expect(th.platformPostId).toBe("post_th_888");
      expect(th.submissionEndpoint).toBe("https://graph.threads.net/v1.0/me/threads_publish");
      expect(th.postUrl).toBe("https://www.threads.net/t/post_th_888");

      const x = body.posts.find((p: any) => p.channel === "x");
      expect(x).toBeDefined();
      expect(x.status).toBe("dry-run-posted");
      expect(x.submissionEndpoint).toBe("https://api.twitter.com/2/tweets");
      expect(x.postUrl).toBeNull();
    });
  });
});

