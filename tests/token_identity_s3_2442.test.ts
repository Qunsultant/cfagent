/**
 * Issue #2442 S3: remaining E*TRADE token consumers must resolve identity
 * through the #2386 seam, the way the panel and (via #2440) the guard do.
 *
 * Before this slice, these four call sites read login-scoped + unscoped
 * keys only, so a token stored under an internal-id or alias-login key
 * was invisible to them while the panel showed connected:
 * - ScheduledTasksService.autoRenewETradeTokens (read + renew)
 * - autopilot balance-snapshot verdict (fetchBrokerBalanceSnapshot)
 * - broker diagnostics verdict (handleEtradeDiagnostics)
 * - Worker 03:00 renewal pass (renewAllStoredETradeTokens)
 * Each test pins the fix against the real store (fake SessionStore):
 * internal-id or alias-login token + alias record resolves, no alias
 * record keeps exactly today's behavior, and an unknown login never
 * reads another login's token. The ETradeRestClient data leg is NOT
 * touched here (S2, #2441 owns it); these tests spy its methods only
 * so the verdict, not the client, is what is pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { fetchBrokerBalanceSnapshot } from "../src/agents/orchestrator/autopilot";
import { handleEtradeDiagnostics } from "../src/agents/routes/etradeBrokerDiagnostics";
import {
  renewAllStoredETradeTokens,
  getStoredTokens,
} from "../src/security/etradeOAuth";
import { ETradeRestClient } from "../src/trading";
import type { Env } from "../src/types";

const LOGIN = "s3user";
const OTHER = "s3other";
const INTERNAL_ID = "user-s3-1";
const ALIAS_LOGIN = "s3user-old";

function freshToken(userLogin: string, storedAt?: string) {
  return {
    accessToken: "at",
    accessTokenSecret: "as",
    storedAt: storedAt ?? new Date().toISOString(),
    environment: "TEST",
    userLogin,
  };
}

function expiredToken(userLogin: string) {
  return freshToken(userLogin, new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());
}

function aliasRecord(githubLogin: string, internalUserId: string) {
  return { githubLogin, internalUserId, recordedAtMs: 1, source: "wired-login" };
}

function seedAlias(fake: ReturnType<typeof makeFakeSessionStore>, login: string, internalId: string, aliasLogin: string) {
  fake.seed("sessions", `iaaa-alias:login:${login}`, aliasRecord(login, internalId));
  fake.seed("sessions", `iaaa-alias:user:${internalId}`, aliasRecord(aliasLogin, internalId));
}

function envWithStore(extra: Record<string, unknown> = {}) {
  const fake = makeFakeSessionStore();
  const env = { SESSION_STORE: fake.namespace, ...extra } as unknown as Env;
  return { fake, env };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3 autoRenewETradeTokens identity pass-through", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("oauth_problem=token_rejected", { status: 401 }),
    );
  });
  it("internal-id token + alias record → read hits (renewal attempted, not 'no tokens')", async () => {
    const { fake, env } = envWithStore();
    seedAlias(fake, LOGIN, INTERNAL_ID, ALIAS_LOGIN);
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await service.autoRenewETradeTokens(LOGIN, "TEST");
    // No consumer creds in env, so the renewal itself declines — but the
    // read must have hit: 'renewal rejected', never 'No active tokens'.
    expect(res.success).toBe(false);
    expect(res.error).toContain("renewal rejected");
  });

  it("internal-id token, NO alias record → today's behavior: 'No active tokens'", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await service.autoRenewETradeTokens(LOGIN, "TEST");
    expect(res.success).toBe(true);
    expect((res.data as { renewed: boolean }).renewed).toBe(false);
    expect((res.data as { message: string }).message).toContain("No active");
  });

  it("alias-login token + alias records → read hits", async () => {
    const { fake, env } = envWithStore();
    seedAlias(fake, LOGIN, INTERNAL_ID, ALIAS_LOGIN);
    fake.seed("etrade", `etrade:token:TEST:${ALIAS_LOGIN}`, freshToken(LOGIN));
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await service.autoRenewETradeTokens(LOGIN, "TEST");
    expect(res.success).toBe(false);
    expect(res.error).toContain("renewal rejected");
  });

  it("login-key token, no alias → today's behavior preserved (read hits)", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, freshToken(LOGIN));
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await service.autoRenewETradeTokens(LOGIN, "TEST");
    expect(res.success).toBe(false);
    expect(res.error).toContain("renewal rejected");
  });

  it("unknown login + another login's token → 'No active', never sideways", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${OTHER}`, freshToken(OTHER));
    const service = new ScheduledTasksService(env, undefined, LOGIN);
    const res = await service.autoRenewETradeTokens("ghost", "TEST");
    expect(res.success).toBe(true);
    expect((res.data as { renewed: boolean }).renewed).toBe(false);
    expect((res.data as { message: string }).message).toContain("No active");
  });
});

describe("S3 autopilot balance-snapshot verdict identity pass-through", () => {
  function spyClient() {
    vi.spyOn(ETradeRestClient.prototype, "fetchAccounts").mockResolvedValue([
      { accountKey: "k1", accountId: "a1" },
    ] as never);
    vi.spyOn(ETradeRestClient.prototype, "fetchBalance").mockResolvedValue({
      balance: 42,
    } as never);
  }

  it("internal-id token + alias record → snapshot returned", async () => {
    const { fake, env } = envWithStore();
    seedAlias(fake, LOGIN, INTERNAL_ID, ALIAS_LOGIN);
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    spyClient();
    const snap = await fetchBrokerBalanceSnapshot({ env } as never, LOGIN, "TEST");
    expect(snap).toEqual({ balance: 42 });
  });

  it("internal-id token, NO alias record → null (today's behavior)", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    spyClient();
    const snap = await fetchBrokerBalanceSnapshot({ env } as never, LOGIN, "TEST");
    expect(snap).toBeNull();
  });

  it("unknown login + another login's token → null, never sideways", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${OTHER}`, freshToken(OTHER));
    spyClient();
    const snap = await fetchBrokerBalanceSnapshot({ env } as never, "ghost", "TEST");
    expect(snap).toBeNull();
  });
});

describe("S3 broker diagnostics verdict identity pass-through", () => {
  function spyClient() {
    vi.spyOn(ETradeRestClient.prototype, "fetchAccounts").mockResolvedValue([
      { accountKey: "k1", accountId: "a1" },
    ] as never);
    vi.spyOn(ETradeRestClient.prototype, "fetchBalance").mockResolvedValue({
      balance: 42,
    } as never);
  }

  async function runDiagnostics(env: Env, login: string) {
    const req = new Request("https://agent.test/api/etrade/diagnostics", {
      headers: { "x-user-login": login },
    });
    const res = await handleEtradeDiagnostics(req, "test-session", { env } as never, "TEST");
    return (await res.json()) as any;
  }

  it("internal-id token + alias record → healthy", async () => {
    const { fake, env } = envWithStore();
    seedAlias(fake, LOGIN, INTERNAL_ID, ALIAS_LOGIN);
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    spyClient();
    const body = await runDiagnostics(env, LOGIN);
    expect(body.status).toBe("healthy");
    expect(body.oauthToken.present).toBe(true);
  });

  it("internal-id token, NO alias record → auth_required (today's behavior)", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    spyClient();
    const body = await runDiagnostics(env, LOGIN);
    expect(body.status).toBe("auth_required");
    expect(body.oauthToken.present).toBe(false);
  });

  it("unknown login + another login's token → auth_required, never sideways", async () => {
    const { fake, env } = envWithStore();
    fake.seed("etrade", `etrade:token:TEST:${OTHER}`, freshToken(OTHER));
    spyClient();
    const body = await runDiagnostics(env, "ghost");
    expect(body.status).toBe("auth_required");
  });
});

describe("S3 Worker 03:00 renewal pass identity pass-through", () => {
  function renewEnv() {
    return envWithStore({
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
    });
  }

  function stubRenewUpstream() {
    return vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Access Token has been renewed", { status: 200 }));
  }

  it("internal-id entry + alias record → renewed, upstream called once", async () => {
    const { fake, env } = renewEnv();
    seedAlias(fake, LOGIN, INTERNAL_ID, ALIAS_LOGIN);
    // Seeded one minute ago, not one hour: E*TRADE tokens expire at
    // midnight ET (isTokenExpiredEt), so a 1-hour-old seed crosses the
    // midnight boundary and is skipped as expired whenever CI runs
    // between 00:00 and 01:00 ET — the failure this pins.
    const seededAt = new Date(Date.now() - 60 * 1000).toISOString();
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN, seededAt));
    const fetchSpy = stubRenewUpstream();
    const counts = await renewAllStoredETradeTokens(env);
    expect(counts).toEqual({ renewed: 1, skipped: 0, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://apisb.etrade.com/oauth/renew_access_token"
    );
    const refreshed = await getStoredTokens(env, LOGIN, "TEST", { internalUserId: INTERNAL_ID });
    expect(refreshed).not.toBeNull();
    expect(new Date(refreshed!.storedAt).getTime()).toBeGreaterThan(new Date(seededAt).getTime());
  });

  it("internal-id entry, NO alias record → failed, upstream never called", async () => {
    const { fake, env } = renewEnv();
    fake.seed("etrade", `etrade:token:TEST:${INTERNAL_ID}`, freshToken(LOGIN));
    const fetchSpy = stubRenewUpstream();
    const counts = await renewAllStoredETradeTokens(env);
    expect(counts).toEqual({ renewed: 0, skipped: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("login-key entry, no alias → today's behavior preserved (renewed)", async () => {
    const { fake, env } = renewEnv();
    fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, freshToken(LOGIN));
    const fetchSpy = stubRenewUpstream();
    const counts = await renewAllStoredETradeTokens(env);
    expect(counts).toEqual({ renewed: 1, skipped: 0, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("orphan entry + another login's token → failed, other's token untouched", async () => {
    const { fake, env } = renewEnv();
    // Entry key suffix 'zzz' is no login's key: the value names LOGIN,
    // but LOGIN has no login key and no alias record, so the renewal
    // must miss — never by reading the other login's token. The other
    // login's token sits under an unscoped key (listed, regex-skipped).
    fake.seed("etrade", "etrade:token:TEST:zzz", freshToken(LOGIN));
    fake.seed("etrade", `etrade:token:${OTHER}`, freshToken(OTHER));
    const fetchSpy = stubRenewUpstream();
    const counts = await renewAllStoredETradeTokens(env);
    expect(counts).toEqual({ renewed: 0, skipped: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const other = await getStoredTokens(env, OTHER, "TEST");
    expect(other?.accessToken).toBe("at");
  });

  it("expired entry → skipped, upstream never called (skip rule preserved)", async () => {
    const { fake, env } = renewEnv();
    fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, expiredToken(LOGIN));
    const fetchSpy = stubRenewUpstream();
    const counts = await renewAllStoredETradeTokens(env);
    expect(counts).toEqual({ renewed: 0, skipped: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unscoped entry → regex skip, counted nowhere (skip rule preserved)", async () => {
    const { fake, env } = renewEnv();
    fake.seed("etrade", `etrade:token:${LOGIN}`, freshToken(LOGIN));
    const fetchSpy = stubRenewUpstream();
    const counts = await renewAllStoredETradeTokens(env);
    expect(counts).toEqual({ renewed: 0, skipped: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
