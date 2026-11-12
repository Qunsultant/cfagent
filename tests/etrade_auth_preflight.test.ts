/**
 * Issue #1174 (#1173 S1): E*TRADE auth pre-flight policy.
 *
 * The 2026-10-23 incident: one missed token renewal → six identical
 * scheduled-screen failures overnight, no alert. These tests pin the
 * fix: verify before screening, renew when possible, block ONCE per
 * expiry episode with one alert, and never let the guard itself break
 * a run.
 */
import { describe, expect, it, vi } from "vitest";
import {
  authBlockedMessage,
  authMissingMessage,
  etradeAuthEpisodeKey,
  fireAuthEpisodeAlertOnce,
  guardScheduledETradeAuth,
  preflightETradeAuth,
  type AuthEpisodeStore,
  type ETradeAuthPreflightDeps,
} from "../src/services/etradeAuthPreflight";

function mapStore(): AuthEpisodeStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function deps(over: Partial<ETradeAuthPreflightDeps>): ETradeAuthPreflightDeps {
  return {
    getTokens: async () => ({ storedAt: "2026-10-23T14:00:00.000Z" }),
    renew: async () => ({ storedAt: "2026-10-23T15:00:00.000Z" }),
    isExpired: () => false,
    now: () => Date.parse("2026-10-23T15:00:00.000Z"),
    ...over,
  };
}

describe("preflightETradeAuth", () => {
  it("no stored tokens → no-tokens, renewal never attempted", async () => {
    const renew = vi.fn(async () => null);
    const res = await preflightETradeAuth(
      deps({ getTokens: async () => null, renew }),
      "venus"
    );
    expect(res.status).toBe("no-tokens");
    expect(renew).not.toHaveBeenCalled();
  });

  it("#1200: no stored tokens in production → blocked(no-session)", async () => {
    const res = await preflightETradeAuth(
      deps({ getTokens: async () => null, isProduction: () => true }),
      "venus"
    );
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") expect(res.reason).toBe("no-session");
  });

  it("#1200: expired + renewal failed → blocked(expired)", async () => {
    const res = await preflightETradeAuth(
      deps({ isExpired: () => true, renew: async () => null }),
      "venus"
    );
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") expect(res.reason).toBe("expired");
  });

  it("fresh token → ok, renewal never attempted", async () => {
    const renew = vi.fn(async () => null);
    const res = await preflightETradeAuth(deps({ renew }), "venus");
    expect(res).toEqual({ status: "ok", renewed: false });
    expect(renew).not.toHaveBeenCalled();
  });

  it("expired token + successful renewal → ok(renewed)", async () => {
    const res = await preflightETradeAuth(
      deps({ isExpired: () => true }),
      "venus"
    );
    expect(res).toEqual({ status: "ok", renewed: true });
  });

  it("expired token + failed renewal → blocked with the episode key", async () => {
    const res = await preflightETradeAuth(
      deps({ isExpired: () => true, renew: async () => null }),
      "venus"
    );
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") {
      expect(res.episodeKey).toBe(
        etradeAuthEpisodeKey("venus", Date.parse("2026-10-23T15:00:00.000Z"))
      );
    }
  });
});

describe("etradeAuthEpisodeKey", () => {
  it("one key per ET calendar day across the whole blocked day", () => {
    // 04:46 EDT and 23:59 EDT on 2026-10-23 share an episode.
    const morning = etradeAuthEpisodeKey("venus", Date.parse("2026-10-23T08:46:00.000Z"));
    const night = etradeAuthEpisodeKey("venus", Date.parse("2026-10-24T03:59:00.000Z"));
    expect(morning).toBe(night);
    expect(morning).toContain("2026-10-23");
  });

  it("the next ET day is a new episode", () => {
    const day1 = etradeAuthEpisodeKey("venus", Date.parse("2026-10-24T03:59:00.000Z"));
    const day2 = etradeAuthEpisodeKey("venus", Date.parse("2026-10-24T04:30:00.000Z"));
    expect(day1).not.toBe(day2);
  });
});

describe("fireAuthEpisodeAlertOnce", () => {
  it("fires once per episode; repeats stay quiet", async () => {
    const store = mapStore();
    const fire = vi.fn(async () => {});
    expect(await fireAuthEpisodeAlertOnce(store, "k1", fire)).toBe(true);
    expect(await fireAuthEpisodeAlertOnce(store, "k1", fire)).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("a throwing alert channel neither throws nor spams later", async () => {
    const store = mapStore();
    const fire = vi.fn(async () => {
      throw new Error("slack down");
    });
    expect(await fireAuthEpisodeAlertOnce(store, "k1", fire)).toBe(false);
    // Episode was still marked: the failure cannot become hourly spam.
    expect(await fireAuthEpisodeAlertOnce(store, "k1", fire)).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

describe("guardScheduledETradeAuth", () => {
  const blockedDeps = () =>
    deps({ isExpired: () => true, renew: async () => null });

  it("blocked run: one Slack alert + one bridge record per episode", async () => {
    const store = mapStore();
    const sendSlackAlert = vi.fn(async () => {});
    const bridge = vi.fn(async () => {});
    const base = {
      env: {} as any,
      userLogin: "venus",
      store,
      bridge,
      kind: "stock" as const,
      label: "SP100 stock screen",
      deps: blockedDeps(),
      sendSlackAlert,
    };
    const first = await guardScheduledETradeAuth(base);
    expect(first.blocked).toBe(true);
    if (first.blocked) {
      expect(first.alerted).toBe(true);
      expect(first.error).toContain(authBlockedMessage(true).slice(0, 40));
    }
    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(1);
    const outcome = (bridge.mock.calls[0] as any[])[0];
    expect(outcome).toMatchObject({ kind: "stock", trigger: "scheduled", success: false });

    const second = await guardScheduledETradeAuth(base);
    expect(second.blocked).toBe(true);
    if (second.blocked) expect(second.alerted).toBe(false);
    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("3313-P06 blocked run: bridged outcome carries the trace's scheduleId", async () => {
    const store = mapStore();
    const bridge = vi.fn(async () => {});
    const res = await guardScheduledETradeAuth({
      env: {} as any,
      userLogin: "venus",
      store,
      bridge,
      kind: "stock",
      label: "SP100 stock screen",
      trace: {
        scheduleId: "sched-3313-blocked",
        runId: "stock_scanner:2026-11-11T12:00:00.000Z:NASDAQ100",
        workflow: "autonomousMarketScreen",
        trigger: "scheduled",
        stage: "auth guard",
        firedAt: "2026-11-11T12:00:00.000Z",
        runAs: "venus",
        universe: "NASDAQ100",
      },
      deps: blockedDeps(),
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(true);
    expect(bridge).toHaveBeenCalledTimes(1);
    const outcome = (bridge.mock.calls[0] as any[])[0];
    expect(outcome.scheduleId).toBe("sched-3313-blocked");
  });

  it("fresh token → not blocked, no alert machinery touched", async () => {
    const sendSlackAlert = vi.fn(async () => {});
    const res = await guardScheduledETradeAuth({
      env: {} as any,
      userLogin: "venus",
      kind: "options",
      label: "options screen",
      deps: deps({}),
      sendSlackAlert,
    });
    expect(res.blocked).toBe(false);
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it("no tokens → not blocked (the pipeline's own auth path owns it)", async () => {
    const res = await guardScheduledETradeAuth({
      env: {} as any,
      userLogin: "venus",
      kind: "stock",
      label: "SP100 stock screen",
      deps: deps({ getTokens: async () => null }),
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
  });

  it("#1200: no session in PRODUCTION → blocked(no-session), one connect alert per episode", async () => {
    const store = mapStore();
    const sendSlackAlert = vi.fn(async () => {});
    const bridge = vi.fn(async () => {});
    const base = {
      env: {} as any,
      userLogin: "venus",
      store,
      bridge,
      kind: "options" as const,
      label: "bullish options screen",
      deps: deps({
        getTokens: async () => null,
        isProduction: () => true,
      }),
      sendSlackAlert,
    };
    const first = await guardScheduledETradeAuth(base);
    expect(first.blocked).toBe(true);
    if (first.blocked) {
      expect(first.alerted).toBe(true);
      expect(first.error).toContain(authMissingMessage(true).slice(0, 40));
      expect(first.error).toContain("no stored session");
    }
    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    // Issue #2216 (#1969 P1): the alert renders FROM the catalog, not
    // the old hand-built "connection missing" variant.
    expect(String((sendSlackAlert.mock.calls[0] as any[])[0])).toContain(
      "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account. Please connect your account in Settings."
    );
    expect(String((sendSlackAlert.mock.calls[0] as any[])[0])).toContain(
      "scheduled bullish options screen is blocked"
    );
    expect(bridge).toHaveBeenCalledTimes(1);
    const outcome = (bridge.mock.calls[0] as any[])[0];
    expect(outcome).toMatchObject({
      kind: "options",
      trigger: "scheduled",
      success: false,
    });
    expect(String(outcome.error)).toContain("no stored session");

    const second = await guardScheduledETradeAuth(base);
    expect(second.blocked).toBe(true);
    if (second.blocked) expect(second.alerted).toBe(false);
    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("#1200: no session outside production → still pass-through", async () => {
    const res = await guardScheduledETradeAuth({
      env: {} as any,
      userLogin: "venus",
      kind: "stock",
      label: "SP100 stock screen",
      deps: deps({
        getTokens: async () => null,
        isProduction: () => false,
      }),
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
  });

  it("a guard-internal failure never blocks the run", async () => {
    const res = await guardScheduledETradeAuth({
      env: {} as any,
      userLogin: "venus",
      kind: "stock",
      label: "SP100 stock screen",
      deps: deps({
        getTokens: async () => {
          throw new Error("store exploded");
        },
      }),
      sendSlackAlert: async () => {},
    });
    expect(res.blocked).toBe(false);
  });
});
