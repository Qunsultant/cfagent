/**
 * Issue #5060 (AG-6) — the memory bridge.
 *
 * `mas_memory` (session facts), `mas_learnings` (beliefs), and VectorMemory
 * (recall) had no path between them. The bridge is deliberately narrow: only
 * facts under a durable prefix (`preference:` / `fact:`) that have been
 * stable for the age floor become learnings; a promoted learning is embedded
 * for recall; everything else stays session state. Idempotent, daily-guarded,
 * and never fatal.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORY_CONSOLIDATION_DEFAULT_FACT_PREFIXES,
  MEMORY_CONSOLIDATION_DEFAULTS,
  MEMORY_CONSOLIDATION_DOMAIN,
  consolidateMemory,
  recordConsolidationRun,
  resolveMemoryConsolidationPolicy,
  shouldConsolidate,
} from "../src/services/memoryConsolidation";
import { getActiveLearnings } from "../src/services/learnings";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const NOW = new Date("2026-11-18T12:00:00Z");
const dayAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const policy = { ...MEMORY_CONSOLIDATION_DEFAULTS };

function memoryPort(facts: Array<{ key: string; value: string; updatedAt: string }>) {
  return { listRecent: () => facts };
}

describe("Issue #5060 — memory consolidation", () => {
  describe("1. Policy is externalized", () => {
    it("resolves overrides and falls back on invalid values", () => {
      const resolved = resolveMemoryConsolidationPolicy({
        MEMORY_CONSOLIDATION_FACT_PREFIXES: "pref:, belief:",
        MEMORY_CONSOLIDATION_MIN_AGE_HOURS: "48",
        MEMORY_CONSOLIDATION_VECTORIZE: "false",
        MEMORY_CONSOLIDATION_INTERVAL_HOURS: "12",
      } as any);
      expect(resolved.factPrefixes).toEqual(["pref:", "belief:"]);
      expect(resolved.minAgeHours).toBe(48);
      expect(resolved.vectorize).toBe(false);
      expect(resolved.intervalHours).toBe(12);

      expect(
        resolveMemoryConsolidationPolicy({
          MEMORY_CONSOLIDATION_MIN_AGE_HOURS: "zero",
        } as any).minAgeHours,
      ).toBe(MEMORY_CONSOLIDATION_DEFAULTS.minAgeHours);
    });

    it("states its durable prefixes", () => {
      expect(MEMORY_CONSOLIDATION_DEFAULT_FACT_PREFIXES).toEqual([
        "preference:",
        "fact:",
      ]);
    });
  });

  describe("2. The promotion rule", () => {
    it("promotes a stable durable fact and skips session keys", async () => {
      const sql = new SqliteTestStorage();
      const report = await consolidateMemory(
        {
          memory: memoryPort([
            { key: "preference:theme", value: "dark", updatedAt: dayAgo(30) },
            { key: "fact:timezone", value: "Europe/London", updatedAt: dayAgo(30) },
            { key: "session:last-ticker", value: "NVDA", updatedAt: dayAgo(30) },
          ]),
          sql,
          now: () => NOW,
        },
        policy,
      );

      expect(report.examined).toBe(2);
      expect(report.promoted).toBe(2);
      const learnings = getActiveLearnings(sql, MEMORY_CONSOLIDATION_DOMAIN);
      expect(learnings).toHaveLength(2);
      expect(learnings.map((l) => l.observation)).toContain(
        "preference:theme = dark",
      );
    });

    it("does not promote a fact that has not been stable long enough", async () => {
      const sql = new SqliteTestStorage();
      const report = await consolidateMemory(
        {
          memory: memoryPort([
            { key: "preference:theme", value: "light", updatedAt: dayAgo(1) },
          ]),
          sql,
          now: () => NOW,
        },
        policy,
      );
      expect(report.examined).toBe(1);
      expect(report.promoted).toBe(0);
      expect(report.skippedYoung).toBe(1);
    });

    it("is idempotent: a promoted fact is not promoted twice", async () => {
      const sql = new SqliteTestStorage();
      const deps = {
        memory: memoryPort([
          { key: "fact:timezone", value: "UTC", updatedAt: dayAgo(48) },
        ]),
        sql,
        now: () => NOW,
      };
      const first = await consolidateMemory(deps, policy);
      const second = await consolidateMemory(deps, policy);
      expect(first.promoted).toBe(1);
      expect(second.promoted).toBe(0);
      expect(second.skippedExisting).toBe(1);
      expect(getActiveLearnings(sql, MEMORY_CONSOLIDATION_DOMAIN)).toHaveLength(1);
    });
  });

  describe("3. The vector leg", () => {
    it("embeds promoted learnings and counts vector failures separately", async () => {
      const sql = new SqliteTestStorage();
      const embedded: string[] = [];
      const report = await consolidateMemory(
        {
          memory: memoryPort([
            { key: "fact:a", value: "1", updatedAt: dayAgo(48) },
            { key: "fact:b", value: "2", updatedAt: dayAgo(48) },
          ]),
          sql,
          vectorRemember: async (summary) => {
            if (summary.includes("fact:b")) throw new Error("vector down");
            embedded.push(summary);
          },
          now: () => NOW,
        },
        policy,
      );

      expect(report.promoted).toBe(2);
      expect(report.vectorized).toBe(1);
      expect(report.vectorFailed).toBe(1);
      // A vector miss never loses the learning: both rows are durable.
      expect(getActiveLearnings(sql, MEMORY_CONSOLIDATION_DOMAIN)).toHaveLength(2);
    });

    it("skips the vector leg when disabled", async () => {
      const sql = new SqliteTestStorage();
      const report = await consolidateMemory(
        {
          memory: memoryPort([
            { key: "fact:a", value: "1", updatedAt: dayAgo(48) },
          ]),
          sql,
          vectorRemember: async () => {
            throw new Error("must not be called");
          },
          now: () => NOW,
        },
        { ...policy, vectorize: false },
      );
      expect(report.vectorized).toBe(0);
      expect(report.vectorFailed).toBe(0);
    });
  });

  describe("4. The daily guard", () => {
    it("runs on an empty store, then waits out the interval", async () => {
      const sql = new SqliteTestStorage();
      // The guard compares the marker's stored timestamp to the caller's
      // clock, so this test uses the real clock (the marker is written by
      // SQLite's CURRENT_TIMESTAMP, not by an injectable now).
      const now = new Date();
      expect(shouldConsolidate(sql, policy, now)).toBe(true);
      recordConsolidationRun(sql, {
        examined: 1,
        promoted: 1,
        skippedExisting: 0,
        skippedYoung: 0,
        vectorized: 0,
        vectorFailed: 0,
      });
      expect(shouldConsolidate(sql, policy, now)).toBe(false);
      const later = new Date(now.getTime() + 25 * 3_600_000);
      expect(shouldConsolidate(sql, policy, later)).toBe(true);
    });

    it("honours the kill switch", () => {
      const sql = new SqliteTestStorage();
      expect(
        shouldConsolidate(sql, { ...policy, enabled: false }, NOW),
      ).toBe(false);
    });
  });

  it("never throws when the memory port is unreadable", async () => {
    const sql = new SqliteTestStorage();
    const report = await consolidateMemory(
      {
        memory: {
          listRecent() {
            throw new Error("storage unavailable");
          },
        },
        sql,
        now: () => NOW,
      },
      policy,
    );
    expect(report.skippedReason).toBe("memory_unreadable");
    expect(report.promoted).toBe(0);
  });
});
