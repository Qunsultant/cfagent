// @vitest-environment node
/**
 * Issue #2432 (#1976 step 5a) — the step-5 characterization base.
 *
 * Step 5 migrates the SessionStore funnel's families (sessions,
 * E*TRADE/Public tokens, the IAAA audit log, the residual
 * buckets) behind ports, flag-gated, family by family (slices
 * 5b–5e). This suite is the conformance base those slices are
 * judged against: the side-effectful behaviours catalogued in
 * the step-5 audit §3, pinned over the REAL modules, numbered
 * to match the audit. Flag-off behaviour in every later slice
 * must keep this file green unchanged in expectation.
 *
 * Coverage map (audit §3 item → where it is pinned):
 *
 *  §3.1 expired-row read deletes — NEW here (state level, real
 *       DO); measurement level: sessionstore_resource_rows_1819
 *       ("expired get sums the select and the lazy delete").
 *  §3.2 expired-token read revokes — NEW here (the read itself);
 *       candidate order / corrupt-candidate skip:
 *       etradeTokenResolution2386; midnight-ET predicate:
 *       etrade_oauth ("Midnight US Eastern Time Expiry
 *       Mechanics"); cache epoch rules: etrade_token_cache.
 *  §3.3 renewal window-bound — NEW here (expired renew refuses
 *       and revokes; bulk renew lists via the DO list op and
 *       skips expired; the DO list restriction itself);
 *       before-midnight renew + single-flight: etrade_oauth
 *       (#1245); renew reason codes: etradeTokenResolution2386.
 *  §3.4 consume is a claim — NEW here (real-DO outcomes:
 *       consumed / duplicate / concurrent single winner /
 *       expired claim reclaimable / putIfAbsent over the real
 *       DO); funnel outcomes incl. "unavailable" and
 *       putIfAbsent fail-closed: durable_session_store (#1756).
 *  §3.5 audit append atomicity — audit_store_atomic_1760
 *       (parallel appends, rotation, cap, corrupt live bytes,
 *       genesis); NEW here: the corrupt ARCHIVE segment leg.
 *  §3.6 session absolute expiry — NEW here (create → get
 *       round-trip and corrupt-value → null over the real DO);
 *       update refusals (past-expiry, invalid createdAt,
 *       remaining-TTL write): iaaa_wiring_phase2a; renewal:
 *       session_refresh_renewal; cache + invalidation
 *       obligation: session_read_cache,
 *       iaaa_revocation_session_cache_1750 (#1750).
 *  §3.7 copy-through migration read — durable_session_store
 *       ("migrates a legacy value on first read"; "skips KV
 *       entirely when the fallback is off"). Cited, no new pin:
 *       the funnel is the module under test there and the leg
 *       is already end-to-end at that level.
 *  §3.8 fail-visible audit outcomes — iaaa_audit
 *       (classifyAuditFailure consequential → block /
 *       non-consequential → allow-with-warning; isAuditedSuccess;
 *       AUDIT_WRITE_FAILED returned as data) and
 *       audit_store_atomic_1760 (AUDIT_STORE_FULL as data).
 *       Cited, no new pin.
 *
 * Registry/revocation rows of audit §9 (5a): listing filters to
 * UUID-shaped keys and bulk revocation removes exactly the
 * principal's sessions — iaaa_lifecycle_wiring_1758,
 * iaaa_revocation, iaaa_revocation_targets_1750 (#1758).
 *
 * Source issues per behaviour: #329 (the store), #1756
 * (consume/putIfAbsent claim), #1758 (list restriction, bulk
 * revocation), #1760 (audit append), #1819 (measurement),
 * #2386 (token resolution seam), #1245 (renewal single-flight),
 * #1750 (session cache), #945 (audit failure policy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../src/security/sessionStore";
import {
  consumeStoreKey,
  createStoreKv,
  listStoreEntries,
  type DoNamespaceLike,
} from "../src/data/durableKv";
import {
  createSession,
  getSession,
  deleteSession,
} from "../src/security/session";
import {
  getValidTokens,
  getStoredTokens,
  renewETradeAccessToken,
  renewAllStoredETradeTokens,
  type ETradeTokenSet,
} from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import {
  createAtomicAuditStore,
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
import {
  recordAuditEvent,
  type CreateIaaaAuditEventInput,
} from "../src/security/iaaaAudit";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env, SessionData } from "../src/types";

/**
 * The real SessionStore over node:sqlite, behind a namespace
 * stub that models the DO input gate (one fetch at a time, in
 * call order) — the harness shape of audit_store_atomic_1760.
 */
function makeRealDo() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const stmt = db.prepare(sql);
          if (/^\s*SELECT/i.test(sql)) {
            const rows = stmt.all(...(params as never[]));
            return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
          }
          const info = stmt.run(...(params as never[]));
          return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
        },
      },
    },
  };
  const store = new SessionStore(ctx as never, {} as never);
  let queue: Promise<unknown> = Promise.resolve();
  const namespace: DoNamespaceLike = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (request: Request) => {
        const run = queue.then(() => store.fetch(request));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    }),
  };
  return { db, store, namespace };
}

async function callDo(
  store: SessionStore,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: Record<string, unknown> }> {
  const res = await store.fetch(
    new Request("https://session-store.internal/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, reply: (await res.json()) as Record<string, unknown> };
}

describe("§3.1 expired-row read deletes (real SessionStore DO)", () => {
  it("a get that finds an expired row returns null and the row is gone", async () => {
    const { db, store } = makeRealDo();
    db.prepare(
      "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?)",
    ).run("sessions", "expired-1", "stale", Date.now() - 1_000);

    const { reply } = await callDo(store, { op: "get", ns: "sessions", key: "expired-1" });
    expect(reply.value).toBeNull();
    expect((reply.rowsWritten as number) ?? 0).toBeGreaterThanOrEqual(1);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM kv_store WHERE ns = ? AND key = ?")
      .get("sessions", "expired-1") as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("a live row is served and kept; a missing row reads null and writes nothing", async () => {
    const { store } = makeRealDo();
    await callDo(store, { op: "put", ns: "sessions", key: "live-1", value: "v", ttl: 600 });
    const hit = await callDo(store, { op: "get", ns: "sessions", key: "live-1" });
    expect(hit.reply.value).toBe("v");
    const again = await callDo(store, { op: "get", ns: "sessions", key: "live-1" });
    expect(again.reply.value).toBe("v");

    const miss = await callDo(store, { op: "get", ns: "sessions", key: "nope" });
    expect(miss.reply.value).toBeNull();
    expect(miss.reply.rowsWritten).toBe(0);
  });
});

describe("§3.4 consume is a claim, not a read (real SessionStore DO)", () => {
  it("first claim consumes, second claim duplicates, an expired claim is reclaimable", async () => {
    const { db, namespace } = makeRealDo();
    const claim = { namespace, namespaceName: "payments", key: "x402tx:0xabc", value: "claimed", ttlSeconds: 60 };
    expect(await consumeStoreKey(claim)).toBe("consumed");
    expect(await consumeStoreKey(claim)).toBe("duplicate");

    // Age the claim past its TTL the way time would: the DO's
    // consume op treats an expired row as absent.
    db.prepare("UPDATE kv_store SET expires_at = ? WHERE ns = ? AND key = ?").run(
      Date.now() - 1_000,
      "payments",
      "x402tx:0xabc",
    );
    expect(await consumeStoreKey(claim)).toBe("consumed");
  });

  it("exactly one of five concurrent claims wins", async () => {
    const { namespace } = makeRealDo();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        consumeStoreKey({
          namespace,
          namespaceName: "payments",
          key: "x402tx:race",
          value: "claimed",
          ttlSeconds: 60,
        }),
      ),
    );
    expect(outcomes.filter((o) => o === "consumed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(4);
  });

  it("putIfAbsent claims exactly once over the real DO (#1756)", async () => {
    const { namespace } = makeRealDo();
    const kv = createStoreKv({ namespace, namespaceName: "sessions", legacyFallback: false });
    expect(await kv.putIfAbsent?.("genesis:primary", "winner")).toBe(true);
    expect(await kv.putIfAbsent?.("genesis:primary", "loser")).toBe(false);
    expect(await kv.get("genesis:primary")).toBe("winner");
  });
});

describe("§3.3 the DO list restriction is a security property (real SessionStore DO)", () => {
  it("list is refused outside sessions and the etrade token prefix", async () => {
    const { store, namespace } = makeRealDo();
    await callDo(store, { op: "put", ns: "payments", key: "x402tx:0x1", value: "c" });
    await callDo(store, { op: "put", ns: "etrade", key: "etrade:token:TEST:a@b.c", value: "t" });
    await callDo(store, { op: "put", ns: "etrade", key: "etrade:req_token:TEST:a@b.c", value: "r" });

    const payments = await callDo(store, { op: "list", ns: "payments", key: "" });
    expect(payments.status).toBe(400);
    const reqTokens = await callDo(store, { op: "list", ns: "etrade", key: "etrade:req_token:" });
    expect(reqTokens.status).toBe(400);

    const tokens = await callDo(store, { op: "list", ns: "etrade", key: "etrade:token:" });
    expect(tokens.status).toBe(200);
    expect((tokens.reply.entries as Array<{ key: string }>).map((e) => e.key)).toEqual([
      "etrade:token:TEST:a@b.c",
    ]);

    // The funnel surfaces a refused list as null (fail-visible),
    // never as an empty listing.
    expect(
      await listStoreEntries({ namespace, namespaceName: "payments", prefix: "" }),
    ).toBeNull();
  });
});

describe("§3.5 audit append: corrupt archive segment (real SessionStore DO)", () => {
  function auditInput(action: string, timestamp: number): CreateIaaaAuditEventInput {
    return {
      timestamp,
      type: "auth.login",
      actorPrincipalId: "user-1",
      actorType: "human",
      initiatingPrincipalId: "user-1",
      tenantId: "tenant-1",
      correlationId: `corr-${action}`,
      action,
      decision: "allow",
      policyVersion: "iaaa-audit-1",
      outcome: "succeeded",
    };
  }

  it("a corrupt archive segment fails the append loud and leaves every byte untouched", async () => {
    const { store: doInstance, namespace } = makeRealDo();
    const store = createAtomicAuditStore(namespace, {
      liveMax: 2,
      segmentSize: 2,
      maxArchiveSegments: 2,
    });
    for (let i = 0; i < 3; i++) {
      const r = await recordAuditEvent(store, auditInput(`event:${i}`, 5_000_000 + i));
      expect(r.ok).toBe(true);
    }
    const archiveKey = `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000000`;
    const before = await callDo(doInstance, { op: "get", ns: "sessions", key: IAAA_AUDIT_LOG_KEY });
    expect(JSON.parse(before.reply.value as string)).toHaveLength(1);

    await callDo(doInstance, { op: "put", ns: "sessions", key: archiveKey, value: "{corrupt" });

    const result = await recordAuditEvent(store, auditInput("event:3", 5_000_003));
    expect(result.ok).toBe(false);

    const archiveAfter = await callDo(doInstance, { op: "get", ns: "sessions", key: archiveKey });
    expect(archiveAfter.reply.value).toBe("{corrupt");
    const liveAfter = await callDo(doInstance, { op: "get", ns: "sessions", key: IAAA_AUDIT_LOG_KEY });
    expect(liveAfter.reply.value).toBe(before.reply.value);
  });
});

describe("§3.6 sessions over the real funnel and DO (session.ts)", () => {
  it("create → get round-trips; a corrupt stored value reads as null; delete ends it", async () => {
    const { namespace } = makeRealDo();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    const data: SessionData = {
      githubLogin: "octocat",
      githubAvatar: "https://avatars.example/4242",
      githubName: "Octo Cat",
      createdAt: Date.now(),
    };
    const id = await createSession(env, data);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getSession(env, id)).toEqual(data);

    const corruptId = "22222222-3333-4444-5555-666666666666";
    const ns = namespace.get(namespace.idFromName("kv"));
    await ns.fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "put", ns: "sessions", key: corruptId, value: "{not json" }),
      }),
    );
    expect(await getSession(env, corruptId)).toBeNull();

    await deleteSession(env, id);
    expect(await getSession(env, id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E*TRADE token flows: the fake SessionStore namespace of
// tests/fake-session-store.ts (ns-aware, protocol-faithful) under
// the real etradeOAuth module — the harness of
// etradeTokenResolution2386, whose local fake collapses ns.
// ---------------------------------------------------------------------------

const LOGIN = "User@Example.com";
const AGED = new Date(Date.now() - 3 * 86_400_000).toISOString();

function tokenPayload(storedAt: string, userLogin: string): ETradeTokenSet {
  return {
    accessToken: "tok",
    accessTokenSecret: "sec",
    storedAt,
    environment: "TEST",
    userLogin,
  };
}

describe("§3.2 expired-token read revokes (etradeOAuth getValidTokens)", () => {
  let fake: ReturnType<typeof makeFakeSessionStore>;
  let env: Env;

  beforeEach(() => {
    __resetTokenCache();
    fake = makeFakeSessionStore();
    env = {
      APP_ENV: "TEST",
      ET_API_KEY: ["dummy", "consumer", "key"].join("-"),
      ET_API_SECRET: ["dummy", "consumer", "secret"].join("-"),
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      SESSION_STORE: fake.namespace,
    } as unknown as Env;
  });
  afterEach(() => vi.restoreAllMocks());

  it("a fresh stored token is served (control: the null below is expiry, not the harness)", async () => {
    fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, tokenPayload(new Date().toISOString(), LOGIN));
    const found = await getValidTokens(env, LOGIN);
    expect(found?.accessToken).toBe("tok");
  });

  it("reading a past-midnight token set returns null and deletes the whole revoke set", async () => {
    const expired = tokenPayload(AGED, LOGIN);
    const loginKeys = [
      `etrade:token:TEST:${LOGIN}`,
      `etrade:token:PROD:${LOGIN}`,
      `etrade:token:${LOGIN}`,
      `etrade:token:TEST:${LOGIN.toLowerCase()}`,
      `etrade:token:TEST:${LOGIN.toUpperCase()}`,
      `etrade:req_token:TEST:${LOGIN}`,
      `etrade:req_token:${LOGIN}`,
    ];
    for (const key of loginKeys) fake.seed("etrade", key, expired);
    fake.seed("etrade", "etrade:token:TEST:other@example.com", tokenPayload(new Date().toISOString(), "other@example.com"));

    expect(await getValidTokens(env, LOGIN)).toBeNull();

    for (const key of loginKeys) {
      expect(fake.store.has(`etrade:${key}`), key).toBe(false);
    }
    // Another login's token is never collateral.
    expect(fake.store.has("etrade:etrade:token:TEST:other@example.com")).toBe(true);
    expect(await getStoredTokens(env, LOGIN)).toBeNull();
  });
});

describe("§3.3 renewal is window-bound (etradeOAuth)", () => {
  let fake: ReturnType<typeof makeFakeSessionStore>;
  let env: Env;

  beforeEach(() => {
    __resetTokenCache();
    fake = makeFakeSessionStore();
    env = {
      APP_ENV: "TEST",
      ET_API_KEY: ["dummy", "consumer", "key"].join("-"),
      ET_API_SECRET: ["dummy", "consumer", "secret"].join("-"),
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      SESSION_STORE: fake.namespace,
    } as unknown as Env;
  });
  afterEach(() => vi.restoreAllMocks());

  it("renewing an expired token makes no upstream call, writes nothing, and revokes the set", async () => {
    fake.seed("etrade", `etrade:token:TEST:${LOGIN}`, tokenPayload(AGED, LOGIN));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await renewETradeAccessToken(env, LOGIN)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.store.has(`etrade:etrade:token:TEST:${LOGIN}`)).toBe(false);
  });

  it("bulk renewal lists the token prefix, renews the live entry, and skips the expired one", async () => {
    fake.seed("etrade", "etrade:token:TEST:old@example.com", tokenPayload(AGED, "old@example.com"));
    fake.seed(
      "etrade",
      "etrade:token:TEST:fresh@example.com",
      tokenPayload(new Date().toISOString(), "fresh@example.com"),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const summary = await renewAllStoredETradeTokens(env);
    expect(summary).toEqual({ renewed: 1, skipped: 1, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const renewed = await getStoredTokens(env, "fresh@example.com");
    expect(renewed).not.toBeNull();
    expect(renewed?.storedAt).not.toBe(AGED);
    // The expired entry was skipped, not renewed and not deleted
    // by the bulk pass (its own read path owns the revocation).
    expect(fake.store.has("etrade:etrade:token:TEST:old@example.com")).toBe(true);
  });
});
