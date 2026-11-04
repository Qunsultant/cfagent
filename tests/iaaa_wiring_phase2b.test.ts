/**
 * #945 Wiring Phase 2b-part1 — live enforcement call sites.
 *
 * Tests are written FIRST (TDD): this file must fail on the missing
 * modules before the implementation lands. Coverage:
 * - validateAndTouchWiredSession: wired vs non-wired determination,
 *   fresh reads, idle/absolute rejection, touch + persist + invalidate,
 *   and zero side effects for non-wired sessions.
 * - Logout audit gating predicate: no record unless wiring is ON, the
 *   session has an internalUserId, and a non-blank tenant id is set.
 *   No default tenant is ever invented.
 * - Step-up pilot predicate for API-key minting: off means never
 *   required; on means fail-closed on stale/missing authTimeMs.
 * - Kv-backed audit store: append/list round trip, hash-chain
 *   integrity, corrupt-log refusal, and key-prefix separation.
 */
import { describe, expect, it } from "vitest";
import type { SessionData } from "../src/types";
import {
  validateAndTouchWiredSession,
  type WiredSessionStoreDeps,
} from "../src/security/iaaaEnforcement";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../src/security/sessionPolicy";
import {
  logoutAuditTenant,
  requiresStepUpForMint,
} from "../src/security/iaaaGates";
import {
  createKvAuditStore,
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
import { recordAuditEvent, verifyChain } from "../src/security/iaaaAudit";
import type { KvLike } from "../src/security/kvResilience";

function baseSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "octo",
    githubAvatar: "",
    githubName: "Octo",
    createdAt: 1_000_000,
    ...overrides,
  };
}

function wiredSession(overrides: Partial<SessionData> = {}): SessionData {
  return baseSession({
    internalUserId: "user-1",
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: 1_000_000,
    sessionVersion: 1,
    lastActivityMs: 1_000_000,
    ...overrides,
  });
}

/** In-memory KvLike with call counters and key inspection. */
function memoryKv(): KvLike & {
  keys(): string[];
  gets: number;
  puts: number;
} {
  const map = new Map<string, string>();
  const kv = {
    gets: 0,
    puts: 0,
    keys: () => [...map.keys()],
    async get(key: string) {
      kv.gets += 1;
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      kv.puts += 1;
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
  return kv;
}

function depsFor(store: {
  fresh: SessionData | null;
  persistOk?: boolean;
}): WiredSessionStoreDeps & {
  freshReads: number;
  persists: number;
  invalidates: string[];
} {
  const deps = {
    freshReads: 0,
    persists: 0,
    invalidates: [] as string[],
    async freshRead() {
      deps.freshReads += 1;
      return store.fresh;
    },
    async persist() {
      deps.persists += 1;
      return { ok: store.persistOk ?? true };
    },
    invalidate(sessionId: string) {
      deps.invalidates.push(sessionId);
    },
  };
  return deps;
}

describe("validateAndTouchWiredSession", () => {
  it("non-wired sessions are untouched: no fresh read, persist, or invalidate", async () => {
    const deps = depsFor({ fresh: wiredSession() });
    const result = await validateAndTouchWiredSession(
      deps,
      baseSession(),
      "sess-1",
      1_060_000,
    );
    expect(result).toEqual({ wired: false });
    expect(deps.freshReads).toBe(0);
    expect(deps.persists).toBe(0);
    expect(deps.invalidates).toEqual([]);
  });

  it("null cached session is not wired and causes no side effects", async () => {
    const deps = depsFor({ fresh: wiredSession() });
    const result = await validateAndTouchWiredSession(
      deps,
      null,
      "sess-1",
      1_060_000,
    );
    expect(result).toEqual({ wired: false });
    expect(deps.freshReads).toBe(0);
  });

  it("wired session within idle window validates from the fresh read without persisting", async () => {
    const fresh = wiredSession({ lastActivityMs: 1_050_000 });
    const deps = depsFor({ fresh });
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession({ lastActivityMs: 1_000_000 }),
      "sess-1",
      1_060_000,
    );
    expect(result).toEqual({ wired: true, session: fresh });
    expect(deps.freshReads).toBe(1);
    expect(deps.persists).toBe(0);
    expect(deps.invalidates).toEqual([]);
  });

  it("wired session idle past the configured window is rejected and its cache entry invalidated", async () => {
    const fresh = wiredSession({ lastActivityMs: 1_000_000 });
    const deps = depsFor({ fresh });
    // Configured idle window: last activity 1_000_000, now = exactly deadline.
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      1_000_000 + DEFAULT_IDLE_TIMEOUT_MS,
    );
    expect(result).toEqual({ wired: true, session: null });
    expect(deps.persists).toBe(0);
    expect(deps.invalidates).toEqual(["sess-1"]);
  });

  it("wired session past absolute expiry is rejected, never persisted", async () => {
    const fresh = wiredSession({ lastActivityMs: 10_000_000 });
    const deps = depsFor({ fresh });
    const pastAbsolute = 1_000_000 + 7 * 24 * 60 * 60 * 1000 + 1;
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      pastAbsolute,
    );
    expect(result).toEqual({ wired: true, session: null });
    expect(deps.persists).toBe(0);
    expect(deps.invalidates).toEqual(["sess-1"]);
  });

  it("wired session untouched for >=300s is touched, persisted, and invalidated", async () => {
    const fresh = wiredSession({ lastActivityMs: 1_000_000 });
    const deps = depsFor({ fresh });
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      1_301_000,
    );
    expect(result.wired).toBe(true);
    if (result.wired) {
      expect(result.session?.lastActivityMs).toBe(1_301_000);
      expect(result.session?.internalUserId).toBe("user-1");
    }
    expect(deps.persists).toBe(1);
    expect(deps.invalidates).toEqual(["sess-1"]);
  });

  it("wired session whose store record vanished is denied, not resurrected from cache", async () => {
    const deps = depsFor({ fresh: null });
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      1_060_000,
    );
    expect(result).toEqual({ wired: true, session: null });
    expect(deps.invalidates).toEqual(["sess-1"]);
  });

  it("persist failure is best-effort: the validated session is still returned, cache kept", async () => {
    const fresh = wiredSession({ lastActivityMs: 1_000_000 });
    const deps = depsFor({ fresh, persistOk: false });
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      1_301_000,
    );
    expect(result.wired).toBe(true);
    if (result.wired) {
      expect(result.session?.lastActivityMs).toBe(1_301_000);
    }
    expect(deps.invalidates).toEqual([]);
  });
});

describe("logoutAuditTenant (no invented default tenant)", () => {
  it("returns null when wiring is off, even with tenant", () => {
    expect(
      logoutAuditTenant({
        wiringEnabled: false,
        tenantId: "tenant-1",
      }),
    ).toBeNull();
  });

  // #1760 pin update (was: null without internalUserId): the gate
  // no longer depends on the session's internal id, because the
  // caller must be able to record a logout_audit_skipped event
  // for a legacy session. The tenant still comes from the
  // server-resolved tenant, never from the session, so resolving
  // it fabricates no identity; the caller (handleLogout) still
  // emits the full logout event only for wired sessions.
  it("returns the tenant when wiring is on and tenant is set, regardless of session binding", () => {
    expect(
      logoutAuditTenant({
        wiringEnabled: true,
        tenantId: "tenant-1",
      }),
    ).toBe("tenant-1");
  });

  it("returns null when tenant is unset, blank, or whitespace-only", () => {
    for (const tenantId of [undefined, "", "   "]) {
      expect(
        logoutAuditTenant({
          wiringEnabled: true,
          tenantId,
        }),
      ).toBeNull();
    }
  });

  it("returns the trimmed tenant when wiring is on and tenant set", () => {
    expect(
      logoutAuditTenant({
        wiringEnabled: true,
        tenantId: "  tenant-1 ",
      }),
    ).toBe("tenant-1");
  });
});

describe("requiresStepUpForMint (API-key mint pilot)", () => {
  it("wiring off never requires step-up, even for ancient sessions", () => {
    expect(
      requiresStepUpForMint(baseSession(), false, 99_000_000),
    ).toBe(false);
    expect(
      requiresStepUpForMint(wiredSession({ authTimeMs: 1_000_000 }), false, 99_000_000),
    ).toBe(false);
  });

  it("wiring on requires step-up when authTimeMs is missing (fail closed)", () => {
    const noAuthTime = baseSession({
      internalUserId: "user-1",
      providerIssuer: "https://github.com",
      providerSubject: "42",
      sessionVersion: 1,
      lastActivityMs: 1_000_000,
    });
    expect(requiresStepUpForMint(noAuthTime, true, 1_060_000)).toBe(true);
  });

  it("wiring on requires step-up when authentication is older than 15 minutes", () => {
    expect(
      requiresStepUpForMint(
        wiredSession({ authTimeMs: 1_000_000 }),
        true,
        1_000_000 + 15 * 60 * 1000,
      ),
    ).toBe(true);
  });

  // #3102 (#945 Q4): mint uses the 5-minute
  // integration-credential-management window, not the 15-minute
  // default — so the fresh point moves from 5 minutes to 4.
  it("wiring on allows minting when authentication is fresh (inside the 5-minute Q4 window)", () => {
    expect(
      requiresStepUpForMint(
        wiredSession({ authTimeMs: 1_000_000 }),
        true,
        1_000_000 + 4 * 60 * 1000,
      ),
    ).toBe(false);
  });
});

describe("createKvAuditStore (append-only, iaaa-audit: keys)", () => {
  it("appends and lists events in order with a verifiable hash chain", async () => {
    const kv = memoryKv();
    const store = createKvAuditStore(kv);
    const base = {
      timestamp: 1_000_000,
      type: "auth.logout",
      actorPrincipalId: "user-1",
      actorType: "human" as const,
      initiatingPrincipalId: "user-1",
      tenantId: "tenant-1",
      correlationId: "sess-1",
      action: "auth.logout",
      decision: "allow" as const,
      policyVersion: "iaaa-audit-1",
      outcome: "succeeded" as const,
    };
    const first = await recordAuditEvent(store, base);
    const second = await recordAuditEvent(store, {
      ...base,
      timestamp: 1_001_000,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(2);
    if (second.ok) {
      expect(events[1].previousEventHash).toBe(events[0].eventHash);
    }
    expect(await verifyChain(events)).toBe(true);
    expect(kv.keys().every((key) => key.startsWith(IAAA_AUDIT_KEY_PREFIX))).toBe(true);
    expect(kv.keys()).toContain(IAAA_AUDIT_LOG_KEY);
  });

  it("refuses to overwrite a corrupt log instead of silently destroying evidence", async () => {
    const kv = memoryKv();
    await kv.put(IAAA_AUDIT_LOG_KEY, "{not json");
    const store = createKvAuditStore(kv);
    // recordWiredAuthAudit converts the store's loud failure (list()
    // throws on corrupt bytes) into an ok:false result; the corrupt
    // bytes must survive untouched, never silently overwritten.
    const { recordWiredAuthAudit } = await import("../src/security/iaaaAuthAudit");
    const result = await recordWiredAuthAudit(store, {
      timestamp: 1_000_000,
      type: "auth.logout",
      actorPrincipalId: "user-1",
      actorType: "human",
      initiatingPrincipalId: "user-1",
      tenantId: "tenant-1",
      correlationId: "sess-1",
      action: "auth.logout",
      decision: "allow",
      policyVersion: "iaaa-audit-1",
      outcome: "succeeded",
    });
    expect(result.ok).toBe(false);
    expect(await kv.get(IAAA_AUDIT_LOG_KEY)).toBe("{not json");
  });

  it("list returns copies: mutating the result does not corrupt the store", async () => {
    const kv = memoryKv();
    const store = createKvAuditStore(kv);
    await recordAuditEvent(store, {
      timestamp: 1_000_000,
      type: "auth.logout",
      actorPrincipalId: "user-1",
      actorType: "human",
      initiatingPrincipalId: "user-1",
      tenantId: "tenant-1",
      correlationId: "sess-1",
      action: "auth.logout",
      decision: "allow",
      policyVersion: "iaaa-audit-1",
      outcome: "succeeded",
    });
    const listed = await store.list();
    listed[0].actorPrincipalId = "attacker";
    expect((await store.list())[0].actorPrincipalId).toBe("user-1");
  });
});
