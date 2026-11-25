/**
 * Issue #2442 S3: schedule-create preflight must resolve identity through
 * the #2386 seam. Before this slice it read login-scoped + unscoped keys
 * only, so a schedule create for an already-connected account 409'd when
 * the token lived under an internal-id or alias-login key. Mirrors the
 * tests/schedules_create_route.test.ts harness (mocked agent bases).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

const LOGIN = "s3user";
const INTERNAL_ID = "user-s3-1";
const ALIAS_LOGIN = "s3user-old";

function freshToken(userLogin: string) {
  return JSON.stringify({
    accessToken: "at",
    accessTokenSecret: "as",
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin,
  });
}

function aliasRecord(githubLogin: string, internalUserId: string) {
  return { githubLogin, internalUserId, recordedAtMs: 1, source: "wired-login" };
}

function makeAgent(seeds: Array<{ ns: string; key: string; value: unknown }>) {
  const sql = new MockSqlStorage();
  const ctx = {
    storage: { sql },
    id: { toString: () => "s3-schedules-route-test" },
  } as any;
  const agent: any = Object.create(OrchestratorAgent.prototype);
  agent.ctx = ctx;
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  for (const s of seeds) seedSession(s.ns, s.key, s.value);
  agent.env = {
    APP_ENV: "TEST",
    SESSION_STORE: sessionStoreNs,
  } as any;
  agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
    return { id: "real-schedule-1", callback, payload };
  };
  agent.scheduleEvery = async (intervalSeconds: number, callback: string, payload: any) => {
    return { id: "real-interval-1", callback, payload };
  };
  return agent;
}

async function postCreate(agent: any) {
  const res = await agent.onRequest(
    new Request("https://agent.test/api/schedules/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": LOGIN },
      body: JSON.stringify({
        scheduleType: "cron",
        // Issue #6482 — a yearly cron: the identity preflight these
        // tests pin runs after the floor, so the fixture must pass
        // it first — a daily cron's shortest gap is below the
        // monthly floor and is refused before the preflight runs.
        cron: "0 3 1 1 *",
        callback: "autonomousMarketScreen",
        payload: { universe: "NASDAQ100", maxItems: 100 },
      }),
    })
  );
  return { status: res.status, body: (await res.json()) as any };
}

function aliasSeeds() {
  return [
    { ns: "sessions", key: `iaaa-alias:login:${LOGIN}`, value: aliasRecord(LOGIN, INTERNAL_ID) },
    { ns: "sessions", key: `iaaa-alias:user:${INTERNAL_ID}`, value: aliasRecord(ALIAS_LOGIN, INTERNAL_ID) },
  ];
}

// Issue #5100 (F3 of #5094): creation of an account-scoped schedule
// refuses when the tenant has no binding — the success-path tests seed
// the bound E*TRADE paper account under the trusted login.
function bindingSeeds() {
  return [
    {
      ns: "account_bindings",
      key: `acctbind:v1:${LOGIN}`,
      value: JSON.stringify([
        { broker: "etrade", mode: "paper", accountType: "stock", scope: "tenant", accountId: "ET-123" },
        { broker: "etrade", mode: "paper", accountType: "options", scope: "tenant", accountId: "ET-123" },
      ]),
    },
  ];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("S3 schedule-create preflight identity pass-through", () => {
  it("internal-id token + alias records → create succeeds (no 409)", async () => {
    const agent = makeAgent([
      ...aliasSeeds(),
      ...bindingSeeds(),
      { ns: "etrade", key: `etrade:token:TEST:${INTERNAL_ID}`, value: freshToken(LOGIN) },
    ]);
    const { status, body } = await postCreate(agent);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("internal-id token, NO alias records → 409 (today's behavior)", async () => {
    const agent = makeAgent([
      { ns: "etrade", key: `etrade:token:TEST:${INTERNAL_ID}`, value: freshToken(LOGIN) },
    ]);
    const { status, body } = await postCreate(agent);
    expect(status).toBe(409);
    expect(body.error).toContain("Connect an E*TRADE account");
  });

  it("alias-login token + alias records → create succeeds", async () => {
    const agent = makeAgent([
      ...aliasSeeds(),
      ...bindingSeeds(),
      { ns: "etrade", key: `etrade:token:TEST:${ALIAS_LOGIN}`, value: freshToken(LOGIN) },
    ]);
    const { status, body } = await postCreate(agent);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("login-key token, no alias → today's behavior preserved (create succeeds)", async () => {
    const agent = makeAgent([
      ...bindingSeeds(),
      { ns: "etrade", key: `etrade:token:TEST:${LOGIN}`, value: freshToken(LOGIN) },
    ]);
    const { status, body } = await postCreate(agent);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("no token under any key → 409", async () => {
    const agent = makeAgent([]);
    const { status, body } = await postCreate(agent);
    expect(status).toBe(409);
    expect(body.error).toContain("Connect an E*TRADE account");
  });
});
