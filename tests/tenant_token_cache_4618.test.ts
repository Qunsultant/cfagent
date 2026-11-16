import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetTokenCache,
  invalidateTokenCacheFor,
  readTokenCache,
  tokenCacheEpoch,
  tokenCacheKey,
  writeTokenCache,
} from "../src/security/etradeTokenCache";

describe("Tenant-keyed provider token cache (#4618)", () => {
  beforeEach(() => {
    __resetTokenCache();
  });

  it("isolates cache entries per tenantId even for the same environment and login", () => {
    const keyA = tokenCacheKey("PROD", "alice", "tenant-a");
    const keyB = tokenCacheKey("PROD", "alice", "tenant-b");

    expect(keyA).not.toBe(keyB);

    writeTokenCache(keyA, {
      accessToken: "tok-a",
      accessTokenSecret: "sec-a",
      storedAt: "2026-11-16T00:00:00.000Z",
      environment: "PROD",
      userLogin: "alice",
    });
    writeTokenCache(keyB, {
      accessToken: "tok-b",
      accessTokenSecret: "sec-b",
      storedAt: "2026-11-16T00:00:00.000Z",
      environment: "PROD",
      userLogin: "alice",
    });

    expect(readTokenCache(keyA)?.accessToken).toBe("tok-a");
    expect(readTokenCache(keyB)?.accessToken).toBe("tok-b");
  });

  it("invalidating one tenant's login leaves other tenants' cached entries and epochs untouched", () => {
    const keyA = tokenCacheKey("PROD", "alice", "tenant-a");
    const keyB = tokenCacheKey("PROD", "alice", "tenant-b");

    writeTokenCache(keyA, {
      accessToken: "tok-a",
      accessTokenSecret: "sec-a",
      storedAt: "2026-11-16T00:00:00.000Z",
      environment: "PROD",
      userLogin: "alice",
    });
    writeTokenCache(keyB, {
      accessToken: "tok-b",
      accessTokenSecret: "sec-b",
      storedAt: "2026-11-16T00:00:00.000Z",
      environment: "PROD",
      userLogin: "alice",
    });

    const epochBeforeA = tokenCacheEpoch(keyA);
    const epochBeforeB = tokenCacheEpoch(keyB);

    invalidateTokenCacheFor("alice", "tenant-a");

    expect(readTokenCache(keyA)).toBeUndefined();
    expect(readTokenCache(keyB)?.accessToken).toBe("tok-b");
    expect(tokenCacheEpoch(keyA)).toBeGreaterThan(epochBeforeA);
    expect(tokenCacheEpoch(keyB)).toBe(epochBeforeB);
  });
});
