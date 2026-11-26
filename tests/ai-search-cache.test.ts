/**
 * Issue #278: tests for the bounded in-isolate TTL cache for AI Search
 * queries (src/services/aiSearchCache.ts). The module is SDK-free; the
 * cache under test never touches the network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  AiSearchCache,
  aiSearchCacheKey,
  getAiSearchCache,
  resolveAiSearchCacheConfig,
  __resetAiSearchCacheForTests,
  AI_SEARCH_CACHE_DEFAULT_TTL_MS,
  AI_SEARCH_CACHE_DEFAULT_MAX_ENTRIES,
} from "../src/services/aiSearchCache";

describe("resolveAiSearchCacheConfig", () => {
  // Phase 3 (#6550): the cache TTL/entries vars moved to
  // environment.config.json (defaults.aiSearch). An absent or invalid
  // env now resolves to the FILE values (7200000/1000), not the
  // code defaults (300000/200) — the code defaults survive only as
  // the guard fallback for a value that is invalid after resolution.
  it("returns the file values when env is absent", () => {
    const cfg = resolveAiSearchCacheConfig(undefined);
    expect(cfg.ttlMs).toBe(7200000);
    expect(cfg.maxEntries).toBe(1000);
  });

  it("parses env vars", () => {
    const cfg = resolveAiSearchCacheConfig({
      AI_SEARCH_CACHE_TTL_MS: "60000",
      AI_SEARCH_CACHE_MAX_ENTRIES: "42",
    });
    expect(cfg.ttlMs).toBe(60000);
    expect(cfg.maxEntries).toBe(42);
  });

  it("falls back to the file values on invalid values", () => {
    const cfg = resolveAiSearchCacheConfig({
      AI_SEARCH_CACHE_TTL_MS: "nope",
      AI_SEARCH_CACHE_MAX_ENTRIES: "-5",
    });
    expect(cfg.ttlMs).toBe(7200000);
    expect(cfg.maxEntries).toBe(1000);
  });

  it("keeps the code defaults as the guard fallback constants", () => {
    expect(AI_SEARCH_CACHE_DEFAULT_TTL_MS).toBe(300000);
    expect(AI_SEARCH_CACHE_DEFAULT_MAX_ENTRIES).toBe(200);
  });
});

describe("aiSearchCacheKey", () => {
  it("normalizes case and whitespace", () => {
    expect(aiSearchCacheKey("  NVDA  Earnings  ", "s1")).toBe(
      aiSearchCacheKey("nvda earnings", "S1")
    );
  });

  it("separates scopes (no cross-tenant reads)", () => {
    expect(aiSearchCacheKey("nvda", "session-a")).not.toBe(
      aiSearchCacheKey("nvda", "session-b")
    );
  });

  it("defaults an empty scope", () => {
    expect(aiSearchCacheKey("nvda", "")).toBe(aiSearchCacheKey("nvda", "default"));
  });

  it("keeps result limits isolated in cache keys", () => {
    expect(aiSearchCacheKey("nvda", "session-a", 5)).not.toBe(
      aiSearchCacheKey("nvda", "session-a", 10)
    );
    expect(aiSearchCacheKey("nvda", "session-a", 0)).toBe(
      aiSearchCacheKey("nvda", "session-a", 1)
    );
  });
});

describe("AiSearchCache", () => {
  let now: number;
  let cache: AiSearchCache;

  beforeEach(() => {
    now = 1_000_000;
    cache = new AiSearchCache({ ttlMs: 60_000, maxEntries: 3 }, () => now);
  });

  it("misses on unknown keys and hits after set", () => {
    expect(cache.get("k")).toBeUndefined();
    cache.set("k", { ok: true });
    expect(cache.get("k")).toEqual({ ok: true });
  });

  it("expires entries after TTL (stale results are never served)", () => {
    cache.set("k", "v");
    now += 59_999;
    expect(cache.get("k")).toBe("v");
    now += 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts the oldest entry when over capacity", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("overwriting an existing key does not evict", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("b", 22);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(22);
  });

  it("refreshes the TTL on overwrite", () => {
    cache.set("k", "v1");
    now += 59_000;
    cache.set("k", "v2");
    now += 59_000;
    expect(cache.get("k")).toBe("v2");
  });
});

describe("aiSearchCache header (S4-3)", () => {
  it("names mas.ts searchKnowledge as the reader and never references the nonexistent src/agents/search.ts", () => {
    const src = readFileSync(
      new URL("../src/services/aiSearchCache.ts", import.meta.url),
      "utf8"
    );
    expect(src).toContain("src/agents/mas.ts");
    expect(src).not.toContain("src/agents/search.ts");
  });
});

describe("getAiSearchCache (isolate singleton)", () => {
  beforeEach(() => __resetAiSearchCacheForTests());

  it("returns the same instance within the isolate", () => {
    const a = getAiSearchCache({});
    const b = getAiSearchCache({});
    expect(a).toBe(b);
  });

  it("resolves config from env on first creation", () => {
    const c = getAiSearchCache({ AI_SEARCH_CACHE_TTL_MS: "1234" });
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });
});
