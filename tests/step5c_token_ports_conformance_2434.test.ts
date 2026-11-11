// @vitest-environment node
/**
 * Issue #2434 (#1976 step 5c) — OAuth token family port
 * conformance + dual-composition characterization.
 *
 * The SAME port suite runs against (a) the DO adapter over
 * tests/fake-session-store.ts's protocol fake (via the
 * composition root's namespace seam) and (b) the in-memory
 * adapter. The family's §9 characterization rows (step-5
 * audit §9, 5c row) are then dual-run through the REAL
 * family façades (security/etradeOAuth.ts,
 * security/publicOAuth.ts) with TOKEN_PORTS_ENABLED off
 * (today's funnel composition) and on (the port composition)
 * — the audit §3.2/§3.3 behaviours (candidate resolution
 * order, expired-read revocation, the midnight-ET renewal
 * window, cache rules, PAT verify-before-store) must be
 * identical in both compositions, and a token stored by one
 * composition must read identically through the other (no
 * key or value shape changes).
 *
 * Sabotage pins (mutation evidence in the slice's evidence
 * dir): an expired read that does not revoke, a
 * candidate-order swap, a cache write that ignores the
 * invalidation epoch, and a façade that ignores the flag
 * (the census STEP5C pin) each turn this suite or the census
 * red.
 *
 * Fixture token values are synthetic labels, never
 * credential-shaped literals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createInMemoryTokenPorts,
  createTokenPortsFromNamespace,
} from "../src/data/createTokenPorts";
import { InMemoryTokenFamilyAdapter } from "../src/data/inMemoryTokenFamilyAdapter";
import {
  isTokenPortsEnabled,
  type TokenFamilyHost,
  type TokenFamilyPorts,
} from "../src/data/tokenPorts";
import {
  getETradeAuthStatus,
  getMidnightEtUtcMs,
  getStoredTokens,
  getValidTokens,
  isTokenExpiredEt,
  renewAllStoredETradeTokens,
  renewETradeAccessToken,
  revokeStoredTokens,
  storeAccessTokens,
  type ETradeTokenSet,
} from "../src/security/etradeOAuth";
import {
  connectPublicPersonalToken,
  getPublicConnectionStatus,
  getPublicOAuthPending,
  getStoredPublicTokens,
  publicTokenKey,
  resolvePublicCredentialRef,
  revokeStoredPublicTokens,
  storePublicPersonalToken,
  suggestedPublicCredentialRef,
  type PublicOAuthPending,
  type PublicTokenSet,
} from "../src/security/publicOAuth";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import { sessionStore } from "../src/security/session";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { makeFakeSessionStore, type FakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

const LOGIN = "trader-5c@example.com";
const OTHER = "other-5c@example.com";
const ALIAS = "pre-rename-5c";
const INTERNAL_ID = "v1:5c0123456789abcdef";

const fx = (label: string) => `fixture-${label}-${crypto.randomUUID()}`;

function tokenSet(overrides: Partial<ETradeTokenSet> = {}): ETradeTokenSet {
  return {
    accessToken: fx("access"),
    accessTokenSecret: fx("secret"),
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin: LOGIN,
    ...overrides,
  };
}

/* --------------------- port-level compositions ---------------------- */

interface Composition {
  ports: TokenFamilyPorts;
  seedRaw: (bucket: string, key: string, value: string) => void;
  rawGet: (bucket: string, key: string) => string | null;
  rawDelete: (bucket: string, key: string) => void;
  setAlias: (internalUserId: string, aliasLogin: string) => void;
}

function doComposition(): Composition {
  const fake = makeFakeSessionStore();
  const aliases = new Map<string, string>();
  const host: TokenFamilyHost = {
    envName: (overrideEnv) => (overrideEnv ? overrideEnv.toUpperCase() : "TEST"),
    aliasLogin: async (internalUserId) => aliases.get(internalUserId) ?? null,
  };
  return {
    ports: createTokenPortsFromNamespace(
      fake.namespace as never,
      host,
    ),
    seedRaw: (bucket, key, value) => fake.seed(bucket, key, value),
    rawGet: (bucket, key) => fake.store.get(`${bucket}:${key}`) ?? null,
    rawDelete: (bucket, key) => {
      fake.store.delete(`${bucket}:${key}`);
    },
    setAlias: (id, alias) => aliases.set(id, alias),
  };
}

function memoryComposition(): Composition {
  const adapter = new InMemoryTokenFamilyAdapter();
  return {
    ports: adapter,
    seedRaw: (bucket, key, value) => adapter.seedRaw(bucket, key, value),
    rawGet: (bucket, key) => adapter.rawValue(bucket, key),
    rawDelete: (bucket, key) => adapter.deleteRaw(bucket, key),
    setAlias: (id, alias) => adapter.setAlias(id, alias),
  };
}

const compositions: Array<[string, () => Composition]> = [
  ["DO adapter over the protocol fake", doComposition],
  ["in-memory adapter", memoryComposition],
];

describe.each(compositions)(
  "token family conformance — %s",
  (_name, makeComposition) => {
    beforeEach(() => {
      __resetTokenCache();
    });
    afterEach(() => {
      __resetTokenCache();
    });

    it("declares legacyFallback: false (KV is not part of the store)", () => {
      expect(makeComposition().ports.legacyFallback).toBe(false);
    });

    it("storeAccessTokens writes ONLY the environment-scoped key, in the stored shape", async () => {
      const c = makeComposition();
      await c.ports.etrade.storeAccessTokens(LOGIN, fx("a"), fx("s"), {
        overrideEnv: "TEST",
      });
      const raw = c.rawGet("etrade", `etrade:token:TEST:${LOGIN}`);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as ETradeTokenSet;
      expect(parsed.userLogin).toBe(LOGIN);
      expect(parsed.environment).toBe("TEST");
      expect(typeof parsed.storedAt).toBe("string");
      // No unscoped write (the #329 P3 rule).
      expect(c.rawGet("etrade", `etrade:token:${LOGIN}`)).toBeNull();
    });

    it("identity store dual-writes the internal-id scoped key", async () => {
      const c = makeComposition();
      await c.ports.etrade.storeAccessTokens(LOGIN, fx("a"), fx("s"), {
        overrideEnv: "TEST",
        identity: { internalUserId: INTERNAL_ID },
      });
      expect(c.rawGet("etrade", `etrade:token:TEST:${LOGIN}`)).not.toBeNull();
      expect(c.rawGet("etrade", `etrade:token:TEST:${INTERNAL_ID}`)).not.toBeNull();
    });

    it("resolution order: internal-id → alias → login (scoped), corrupt candidates skipped", async () => {
      const c = makeComposition();
      c.setAlias(INTERNAL_ID, ALIAS);
      const loginTok = tokenSet({ accessToken: fx("login") });
      const aliasTok = tokenSet({ accessToken: fx("alias"), userLogin: ALIAS });
      const internalTok = tokenSet({ accessToken: fx("internal") });
      c.seedRaw("etrade", `etrade:token:TEST:${LOGIN}`, JSON.stringify(loginTok));
      c.seedRaw("etrade", `etrade:token:TEST:${ALIAS}`, JSON.stringify(aliasTok));
      c.seedRaw("etrade", `etrade:token:TEST:${INTERNAL_ID}`, JSON.stringify(internalTok));

      const opts = { overrideEnv: "TEST", identity: { internalUserId: INTERNAL_ID } };
      const first = await c.ports.etrade.resolveTokenSet(LOGIN, opts);
      expect(first?.tokens.accessToken).toBe(internalTok.accessToken);
      expect(first?.key).toBe(`etrade:token:TEST:${INTERNAL_ID}`);

      c.rawDelete("etrade", `etrade:token:TEST:${INTERNAL_ID}`);
      const second = await c.ports.etrade.resolveTokenSet(LOGIN, opts);
      expect(second?.tokens.accessToken).toBe(aliasTok.accessToken);
      expect(second?.key).toBe(`etrade:token:TEST:${ALIAS}`);

      // A corrupt candidate never blocks the healthy fallback.
      c.seedRaw("etrade", `etrade:token:TEST:${ALIAS}`, "{corrupt");
      const third = await c.ports.etrade.resolveTokenSet(LOGIN, opts);
      expect(third?.tokens.accessToken).toBe(loginTok.accessToken);
      expect(third?.key).toBe(`etrade:token:TEST:${LOGIN}`);
    });

    it("request-token secret: scoped + unscoped write, candidate read incl. alias fallback", async () => {
      const c = makeComposition();
      await c.ports.etrade.storeRequestTokenSecret(LOGIN, fx("rt"), fx("rs"), {
        overrideEnv: "TEST",
      });
      expect(c.rawGet("etrade", `etrade:req_token:TEST:${LOGIN}`)).not.toBeNull();
      expect(c.rawGet("etrade", `etrade:req_token:${LOGIN}`)).not.toBeNull();
      const read = await c.ports.etrade.getRequestTokenSecret(LOGIN, {
        overrideEnv: "TEST",
      });
      expect(read?.requestToken).toBeTruthy();

      // Secret stored only under the alias login resolves via identity.
      c.setAlias(INTERNAL_ID, ALIAS);
      await c.ports.etrade.storeRequestTokenSecret(ALIAS, fx("rt2"), fx("rs2"), {
        overrideEnv: "TEST",
      });
      const viaAlias = await c.ports.etrade.getRequestTokenSecret(LOGIN, {
        overrideEnv: "TEST",
        identity: { internalUserId: INTERNAL_ID },
      });
      expect(viaAlias?.requestToken).toBeTruthy();
    });

    it("revokeStoredTokens deletes the full enumerated set and nothing else", async () => {
      const c = makeComposition();
      c.setAlias(INTERNAL_ID, ALIAS);
      const logins = [LOGIN, LOGIN.toLowerCase(), LOGIN.toUpperCase(), INTERNAL_ID, ALIAS];
      const keys: string[] = [];
      for (const l of logins) {
        keys.push(
          `etrade:token:PROD:${l}`,
          `etrade:token:TEST:${l}`,
          `etrade:req_token:PROD:${l}`,
          `etrade:req_token:TEST:${l}`,
          `etrade:token:${l}`,
          `etrade:req_token:${l}`,
        );
      }
      for (const k of keys) c.seedRaw("etrade", k, JSON.stringify(tokenSet()));
      const otherKey = `etrade:token:TEST:${OTHER}`;
      c.seedRaw("etrade", otherKey, JSON.stringify(tokenSet({ userLogin: OTHER })));

      await c.ports.etrade.revokeStoredTokens(LOGIN, {
        identity: { internalUserId: INTERNAL_ID },
      });
      for (const k of keys) expect(c.rawGet("etrade", k)).toBeNull();
      expect(c.rawGet("etrade", otherKey)).not.toBeNull();
    });

    it("getValidTokens: identity-aware reads bypass the isolate cache", async () => {
      const c = makeComposition();
      const set = tokenSet();
      c.seedRaw("etrade", `etrade:token:TEST:${LOGIN}`, JSON.stringify(set));
      const first = await c.ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" });
      expect(first?.accessToken).toBe(set.accessToken);
      // Delete behind the cache's back: the identity-less read is
      // still served the cached verdict, the identity-aware read
      // sees the store truth (#2386).
      c.rawDelete("etrade", `etrade:token:TEST:${LOGIN}`);
      const cached = await c.ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" });
      expect(cached?.accessToken).toBe(set.accessToken);
      const fresh = await c.ports.etrade.getValidTokens(LOGIN, {
        overrideEnv: "TEST",
        identity: { internalUserId: INTERNAL_ID },
      });
      expect(fresh).toBeNull();
    });

    it("getValidTokens: the unscoped-environment guard applies only to unscoped hits", async () => {
      const c = makeComposition();
      const prodSet = tokenSet({ environment: "PROD" });
      c.seedRaw("etrade", `etrade:token:${LOGIN}`, JSON.stringify(prodSet));
      // Resolved environment is TEST; the only copy is an unscoped
      // PROD token — it must not count.
      expect(
        await c.ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" }),
      ).toBeNull();

      const testSet = tokenSet({ environment: "TEST", accessToken: fx("t") });
      c.seedRaw("etrade", `etrade:token:${OTHER}`, JSON.stringify(testSet));
      expect(
        (await c.ports.etrade.getValidTokens(OTHER, { overrideEnv: "TEST" }))
          ?.accessToken,
      ).toBe(testSet.accessToken);
    });

    it("getValidTokens: an expired read revokes the full set, invalidates cache, returns null (§3.2)", async () => {
      const c = makeComposition();
      c.setAlias(INTERNAL_ID, ALIAS);
      const expired = tokenSet({
        storedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      });
      const keys = [
        `etrade:token:TEST:${LOGIN}`,
        `etrade:token:PROD:${LOGIN}`,
        `etrade:token:${LOGIN}`,
        `etrade:req_token:TEST:${LOGIN}`,
        `etrade:token:TEST:${INTERNAL_ID}`,
        `etrade:token:TEST:${ALIAS}`,
      ];
      for (const k of keys) c.seedRaw("etrade", k, JSON.stringify(expired));
      const otherKey = `etrade:token:TEST:${OTHER}`;
      c.seedRaw("etrade", otherKey, JSON.stringify(tokenSet({ userLogin: OTHER })));

      const res = await c.ports.etrade.getValidTokens(LOGIN, {
        overrideEnv: "TEST",
        identity: { internalUserId: INTERNAL_ID },
      });
      expect(res).toBeNull();
      for (const k of keys) expect(c.rawGet("etrade", k)).toBeNull();
      expect(c.rawGet("etrade", otherKey)).not.toBeNull();
      // Cache was invalidated by the revocation: an identity-less
      // read still resolves to null, never a resurrected verdict.
      expect(
        await c.ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" }),
      ).toBeNull();
    });

    it("getValidTokens: the midnight-ET boundary — 23:59:59 ET serves, 00:00:00 ET revokes", async () => {
      const c = makeComposition();
      const midnightToday = getMidnightEtUtcMs(Date.now());
      const midnightTomorrow = getMidnightEtUtcMs(midnightToday + 36 * 3600 * 1000);
      const stored = tokenSet({
        storedAt: new Date(midnightToday + 12 * 3600 * 1000).toISOString(),
      });
      c.seedRaw("etrade", `etrade:token:TEST:${LOGIN}`, JSON.stringify(stored));
      vi.useFakeTimers();
      try {
        vi.setSystemTime(midnightTomorrow - 1000);
        expect(
          (await c.ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" }))
            ?.accessToken,
        ).toBe(stored.accessToken);
        vi.setSystemTime(midnightTomorrow);
        // Identity-aware read (cache bypass) at the boundary.
        expect(
          await c.ports.etrade.getValidTokens(LOGIN, {
            overrideEnv: "TEST",
            identity: { internalUserId: INTERNAL_ID },
          }),
        ).toBeNull();
        expect(c.rawGet("etrade", `etrade:token:TEST:${LOGIN}`)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("scope presence: per-scope booleans, corrupt counts as present", async () => {
      const c = makeComposition();
      await c.ports.etrade.storeAccessTokens(LOGIN, fx("a"), fx("s"), {
        overrideEnv: "TEST",
        identity: { internalUserId: INTERNAL_ID },
      });
      c.seedRaw("etrade", `etrade:token:${LOGIN}`, "{corrupt-but-present");
      const presence = await c.ports.etrade.getTokenScopePresence(LOGIN, {
        overrideEnv: "TEST",
        identity: { internalUserId: INTERNAL_ID },
      });
      expect(presence).toEqual({
        loginScoped: true,
        unscoped: true,
        internalId: true,
        aliasLogin: false,
      });
    });

    it("listTokenEntries lists only the requested prefix", async () => {
      const c = makeComposition();
      c.seedRaw("etrade", `etrade:token:TEST:${LOGIN}`, JSON.stringify(tokenSet()));
      c.seedRaw(
        "etrade",
        `etrade:token:PROD:${OTHER}`,
        JSON.stringify(tokenSet({ userLogin: OTHER, environment: "PROD" })),
      );
      c.seedRaw("etrade", `etrade:req_token:TEST:${LOGIN}`, JSON.stringify({}));
      const entries = await c.ports.etrade.listTokenEntries("etrade:token:");
      expect(entries?.map((e) => e.key).sort()).toEqual([
        `etrade:token:PROD:${OTHER}`,
        `etrade:token:TEST:${LOGIN}`,
      ]);
    });

    it("public: token set store → get → delete round-trip; corrupt reads null", async () => {
      const c = makeComposition();
      const set: PublicTokenSet = {
        kind: "personal",
        accessToken: fx("pat"),
        storedAt: new Date().toISOString(),
        userLogin: LOGIN,
      };
      await c.ports.public.storeTokenSet(set);
      expect(await c.ports.public.getTokenSet(LOGIN)).toEqual(set);
      expect(c.rawGet("public", publicTokenKey(LOGIN))).not.toBeNull();

      c.seedRaw("public", publicTokenKey(OTHER), "{corrupt");
      expect(await c.ports.public.getTokenSet(OTHER)).toBeNull();
      c.seedRaw("public", publicTokenKey(OTHER), JSON.stringify({ nope: 1 }));
      expect(await c.ports.public.getTokenSet(OTHER)).toBeNull();

      await c.ports.public.deleteTokenSet(LOGIN);
      expect(await c.ports.public.getTokenSet(LOGIN)).toBeNull();
    });

    it("public: pending-flow record round-trip", async () => {
      const c = makeComposition();
      const pending: PublicOAuthPending = {
        state: "state-5c",
        codeVerifier: fx("verifier"),
        clientId: "https://app.example/.well-known/oauth-client-id-metadata-document",
        issuer: "https://issuer.example",
        tokenEndpoint: "https://issuer.example/token",
        redirectUri: "https://app.example/auth/public/callback",
        userLogin: LOGIN,
        createdAt: 1_000,
      };
      await c.ports.public.storePending(pending);
      expect(await c.ports.public.getPending("state-5c")).toEqual(pending);
      await c.ports.public.deletePending("state-5c");
      expect(await c.ports.public.getPending("state-5c")).toBeNull();
    });

    it("public: readRefRecord reads the referenced bucket/key, null on miss", async () => {
      const c = makeComposition();
      c.seedRaw("public", publicTokenKey(LOGIN), "{\"accessToken\":\"x\"}");
      expect(await c.ports.public.readRefRecord("public", publicTokenKey(LOGIN))).toBe(
        "{\"accessToken\":\"x\"}",
      );
      expect(await c.ports.public.readRefRecord("public", "public:token:ghost")).toBeNull();
      c.seedRaw("some_other_ns", "k1", "v1");
      expect(await c.ports.public.readRefRecord("some_other_ns", "k1")).toBe("v1");
    });
  },
);

/* --------------------- flag semantics (#1169 idiom) ------------------ */

describe("TOKEN_PORTS_ENABLED flag semantics (#1169 idiom)", () => {
  it("absence = off; 1/true/on (any case, trimmed) = on; anything else = off", () => {
    expect(isTokenPortsEnabled({})).toBe(false);
    expect(isTokenPortsEnabled({ TOKEN_PORTS_ENABLED: "true" })).toBe(true);
    expect(isTokenPortsEnabled({ TOKEN_PORTS_ENABLED: " ON " })).toBe(true);
    expect(isTokenPortsEnabled({ TOKEN_PORTS_ENABLED: "1" })).toBe(true);
    expect(isTokenPortsEnabled({ TOKEN_PORTS_ENABLED: "0" })).toBe(false);
    expect(isTokenPortsEnabled({ TOKEN_PORTS_ENABLED: "false" })).toBe(false);
    expect(isTokenPortsEnabled(null)).toBe(false);
    expect(isTokenPortsEnabled(undefined)).toBe(false);
  });
});

/* --------------- epoch guard under a delayed store read -------------- */

describe("getValidTokens epoch guard (DO composition, delayed read)", () => {
  beforeEach(() => __resetTokenCache());
  afterEach(() => __resetTokenCache());

  it("a read in flight across a revocation does not resurrect the token in cache (#1218)", async () => {
    const fake = makeFakeSessionStore();
    let release: (() => void) | null = null;
    let armed = true;
    const namespace = {
      idFromName: fake.namespace.idFromName,
      get: (id: unknown) => {
        const stub = fake.namespace.get(id);
        return {
          fetch: async (req: Request) => {
            const body = (await req
              .clone()
              .json()
              .catch(() => ({}))) as { op?: string; ns?: string };
            if (armed && body.op === "get" && body.ns === "etrade") {
              armed = false;
              // Snapshot the reply now, deliver it after release.
              const snapshot = await stub.fetch(
                new Request("http://fake.local", {
                  method: "POST",
                  body: JSON.stringify(body),
                }),
              );
              const text = await snapshot.text();
              return new Promise<Response>((resolve) => {
                release = () =>
                  resolve(
                    new Response(text, {
                      status: 200,
                      headers: { "Content-Type": "application/json" },
                    }),
                  );
              });
            }
            return stub.fetch(req);
          },
        };
      },
    };
    const host: TokenFamilyHost = {
      envName: (o) => (o ? o.toUpperCase() : "TEST"),
      aliasLogin: async () => null,
    };
    const ports = createTokenPortsFromNamespace(namespace as never, host);
    const set = tokenSet();
    fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, JSON.stringify(set));

    const inFlight = ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" });
    // Let the read reach the delayed get, then revoke underneath it.
    await vi.waitFor(() => expect(release).not.toBeNull());
    await ports.etrade.revokeStoredTokens(LOGIN, {});
    release!();
    const landed = await inFlight;
    expect(landed?.accessToken).toBe(set.accessToken);
    // The stale landing must NOT have been cached: the next read
    // goes back to the store and finds the revocation's truth.
    expect(fake.store.get(`etrade:etrade:token:TEST:${LOGIN}`)).toBeUndefined();
    expect(
      await ports.etrade.getValidTokens(LOGIN, { overrideEnv: "TEST" }),
    ).toBeNull();
  });
});

/* ------------- dual-run façade characterization (§9, 5c) ------------- */

const flagStates: Array<[string, string | undefined]> = [
  ["flag OFF (today's funnel)", undefined],
  ["flag ON (port composition)", "true"],
];

function facadeEnv(fake: FakeSessionStore, flag?: string): Env {
  return {
    APP_ENV: "TEST",
    ET_API_KEY: "test-consumer-key",
    ET_API_SECRET: "test-consumer-secret",
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    SESSION_STORE: fake.namespace,
    ...(flag ? { TOKEN_PORTS_ENABLED: flag } : {}),
  } as unknown as Env;
}

describe("5c façade characterization dual-run (§9)", () => {
  beforeEach(() => {
    __resetTokenCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetTokenCache();
  });

  it.each(flagStates)(
    "%s: store → status/getValid round-trip; scoped key shape unchanged",
    async (_n, flag) => {
      const fake = makeFakeSessionStore();
      const env = facadeEnv(fake, flag);
      await storeAccessTokens(env, LOGIN, fx("a"), fx("s"));
      expect(fake.store.get(`etrade:etrade:token:TEST:${LOGIN}`)).toBeTruthy();
      expect(fake.store.get(`etrade:etrade:token:${LOGIN}`)).toBeUndefined();
      expect((await getValidTokens(env, LOGIN))?.accessToken).toBeTruthy();
      expect((await getETradeAuthStatus(env, LOGIN)).authenticated).toBe(true);
      expect((await getETradeAuthStatus(env, OTHER)).authenticated).toBe(false);
    },
  );

  it.each(flagStates)(
    "%s: identity + alias resolution and full revoke through the façade",
    async (_n, flag) => {
      const fake = makeFakeSessionStore();
      const env = facadeEnv(fake, flag);
      await recordLoginAlias(sessionStore(env), {
        githubLogin: ALIAS,
        internalUserId: INTERNAL_ID,
        nowMs: Date.now(),
      });
      await storeAccessTokens(env, ALIAS, fx("alias-tok"), fx("alias-secret"));
      const identity = { internalUserId: INTERNAL_ID };
      expect((await getValidTokens(env, LOGIN, undefined, identity))?.accessToken)
        .toBeTruthy();
      await revokeStoredTokens(env, LOGIN, undefined, identity);
      expect(await getValidTokens(env, LOGIN, undefined, identity)).toBeNull();
      expect(await getStoredTokens(env, ALIAS)).toBeNull();
    },
  );

  it.each(flagStates)(
    "%s: expired read revokes through the façade (§3.2)",
    async (_n, flag) => {
      const fake = makeFakeSessionStore();
      const env = facadeEnv(fake, flag);
      const expired = tokenSet({
        storedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      });
      fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, expired);
      fake.seed("etrade", `etrade:token:${LOGIN}`, expired);
      expect(await getValidTokens(env, LOGIN)).toBeNull();
      expect(fake.store.get(`etrade:etrade:token:TEST:${LOGIN}`)).toBeUndefined();
      expect(fake.store.get(`etrade:etrade:token:${LOGIN}`)).toBeUndefined();
    },
  );

  it("a token stored flag-OFF reads identically flag-ON, and vice versa", async () => {
    const fake = makeFakeSessionStore();
    const offEnv = facadeEnv(fake, undefined);
    const onEnv = facadeEnv(fake, "true");
    await storeAccessTokens(offEnv, LOGIN, fx("cross"), fx("cross-secret"));
    const viaOn = await getValidTokens(onEnv, LOGIN);
    expect(viaOn?.userLogin).toBe(LOGIN);

    await revokeStoredTokens(onEnv, LOGIN);
    expect(await getValidTokens(offEnv, LOGIN)).toBeNull();

    const cross2 = fx("cross2");
    await storeAccessTokens(onEnv, LOGIN, cross2, fx("cross2-secret"));
    expect((await getValidTokens(offEnv, LOGIN))?.accessToken).toBe(cross2);
    expect(await getStoredTokens(offEnv, LOGIN)).not.toBeNull();
  });

  it.each(flagStates)(
    "%s: renewal window — 23:59:59 ET renews, 00:00:00 ET is TOKEN_EXPIRED (§3.3)",
    async (_n, flag) => {
      const midnightToday = getMidnightEtUtcMs(Date.now());
      const midnightTomorrow = getMidnightEtUtcMs(midnightToday + 36 * 3600 * 1000);
      const storedMs = midnightToday + 12 * 3600 * 1000; // today 12:00 ET

      // 23:59:59 ET: still the stored day — renewal proceeds.
      {
        const fake = makeFakeSessionStore();
        const env = facadeEnv(fake, flag);
        fake.seed(
          "etrade",
          `etrade:token:TEST:${LOGIN}`,
          tokenSet({ storedAt: new Date(storedMs).toISOString() }),
        );
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(
            new Response(
              "oauth_token=renewed-fixture&oauth_token_secret=renewed-secret-fixture",
              { status: 200 },
            ),
          );
        vi.useFakeTimers();
        vi.setSystemTime(midnightTomorrow - 1000);
        const renewed = await renewETradeAccessToken(env, LOGIN);
        vi.useRealTimers();
        expect(renewed).not.toBeNull();
        expect(fetchSpy).toHaveBeenCalled();
        fetchSpy.mockRestore();
      }

      // 00:00:00 ET next day: expired — no upstream call, no renewal,
      // and the expired set is revoked by the attempt.
      {
        const fake = makeFakeSessionStore();
        const env = facadeEnv(fake, flag);
        fake.seed(
          "etrade",
          `etrade:token:TEST:${LOGIN}`,
          tokenSet({ storedAt: new Date(storedMs).toISOString() }),
        );
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        vi.useFakeTimers();
        vi.setSystemTime(midnightTomorrow);
        const renewed = await renewETradeAccessToken(env, LOGIN);
        vi.useRealTimers();
        expect(renewed).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(fake.store.get(`etrade:etrade:token:TEST:${LOGIN}`)).toBeUndefined();
        fetchSpy.mockRestore();
      }
    },
  );

  it.each(flagStates)(
    "%s: bulk renewal lists via the token prefix and skips expired entries",
    async (_n, flag) => {
      const fake = makeFakeSessionStore();
      const env = facadeEnv(fake, flag);
      fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, tokenSet());
      fake.seed(
        "etrade",
        `etrade:token:TEST:${OTHER}`,
        tokenSet({
          userLogin: OTHER,
          storedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        }),
      );
      fake.seed("etrade", `etrade:req_token:TEST:${LOGIN}`, { requestToken: "r" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            "oauth_token=renewed-fixture&oauth_token_secret=renewed-secret-fixture",
            { status: 200 },
          ),
        );
      const result = await renewAllStoredETradeTokens(env);
      expect(result).toEqual({ renewed: 1, skipped: 1, failed: 0 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    },
  );

  it.each(flagStates)(
    "%s: Public PAT verify-before-store — an unverifiable token is never stored",
    async (_n, flag) => {
      const fake = makeFakeSessionStore();
      const env = facadeEnv(fake, flag);
      const badFetch = vi
        .fn()
        .mockResolvedValue(new Response("nope", { status: 500 })) as never;
      await expect(
        connectPublicPersonalToken(env, LOGIN, fx("pat"), badFetch),
      ).rejects.toThrow();
      expect(await getStoredPublicTokens(env, LOGIN)).toBeNull();

      const goodFetch = vi.fn().mockResolvedValue(
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "get_quote" }] },
        }),
      ) as never;
      const connected = await connectPublicPersonalToken(env, LOGIN, fx("pat"), goodFetch);
      expect(connected.toolCount).toBe(1);
      const stored = await getStoredPublicTokens(env, LOGIN);
      expect(stored?.kind).toBe("personal");
      // #4035: verification is evidence, not a boolean.
      expect(stored?.verifiedTools).toEqual(["get_quote"]);
      expect(typeof stored?.verifiedAt).toBe("string");
      const status = await getPublicConnectionStatus(env, LOGIN);
      expect(status.connected).toBe(true);
      expect(status.verifiedAt).toBe(stored?.verifiedAt);
      expect(status.toolCount).toBe(1);
      expect(status.tools).toEqual(["get_quote"]);
    },
  );

  it.each(flagStates)(
    "%s: Public façade round-trip + credential-ref resolution with named errors",
    async (_n, flag) => {
      const fake = makeFakeSessionStore();
      const env = facadeEnv(fake, flag);
      await storePublicPersonalToken(env, LOGIN, fx("pat"));
      expect((await getStoredPublicTokens(env, LOGIN))?.kind).toBe("personal");

      const ok = await resolvePublicCredentialRef(
        env,
        LOGIN,
        suggestedPublicCredentialRef(LOGIN),
      );
      expect(ok.ok).toBe(true);

      const noRef = await resolvePublicCredentialRef(env, LOGIN, null);
      expect(noRef.ok).toBe(false);
      if (!noRef.ok) expect(noRef.error).toContain("no credential reference");

      const incomplete = await resolvePublicCredentialRef(env, LOGIN, "sessionstore:public");
      expect(incomplete.ok).toBe(false);
      if (!incomplete.ok) expect(incomplete.error).toContain("not a complete sessionstore reference");

      const ghost = await resolvePublicCredentialRef(
        env,
        LOGIN,
        "sessionstore:public:public:token:ghost",
      );
      expect(ghost.ok).toBe(false);
      if (!ghost.ok) expect(ghost.error).toContain("no Public token is stored");

      fake.seed("public", "public:token:broken", "{not a token set");
      const broken = await resolvePublicCredentialRef(
        env,
        LOGIN,
        "sessionstore:public:public:token:broken",
      );
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.error).toContain("is not a Public token set");

      await revokeStoredPublicTokens(env, LOGIN);
      expect(await getStoredPublicTokens(env, LOGIN)).toBeNull();
    },
  );

  it.each(flagStates)("%s: Public pending record reads through the façade", async (_n, flag) => {
    const fake = makeFakeSessionStore();
    const env = facadeEnv(fake, flag);
    const pending: PublicOAuthPending = {
      state: "state-5c-facade",
      codeVerifier: fx("verifier"),
      clientId: "https://app.example/.well-known/oauth-client-id-metadata-document",
      issuer: "https://issuer.example",
      tokenEndpoint: "https://issuer.example/token",
      redirectUri: "https://app.example/auth/public/callback",
      userLogin: LOGIN,
      createdAt: 1_000,
    };
    fake.seed("public", "public:oauth_pending:state-5c-facade", pending);
    expect(await getPublicOAuthPending(env, "state-5c-facade")).toEqual(pending);
    expect(await getPublicOAuthPending(env, "missing")).toBeNull();
  });
});

/* ---------------- midnight-ET predicate boundary pins ---------------- */

describe("midnight-ET window predicate (caller-supplied clock seam)", () => {
  it("23:59:59 ET on the stored day is not expired; 00:00:00 ET next day is", () => {
    const midnightToday = getMidnightEtUtcMs(Date.now());
    const midnightTomorrow = getMidnightEtUtcMs(midnightToday + 36 * 3600 * 1000);
    const storedIso = new Date(midnightToday + 12 * 3600 * 1000).toISOString();
    expect(isTokenExpiredEt(storedIso, midnightTomorrow - 1000)).toBe(false);
    expect(isTokenExpiredEt(storedIso, midnightTomorrow)).toBe(true);
  });
});
