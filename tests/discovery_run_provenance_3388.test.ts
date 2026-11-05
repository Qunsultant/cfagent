/**
 * Issue #3388 slice 1 — discovery runs carry the broker that produced them.
 *
 * Provenance rides inside the run summary (the #3327 shape), so there is no
 * column migration and legacy rows answer honestly: every run written before
 * provenance existed came from the E*TRADE-wired engine, so it reads as
 * `etrade` — never as another broker's evidence.
 *
 * What these tests defend:
 *   1. Normalization: absent/unknown → `etrade`, `alpaca` → `alpaca`.
 *   2. Both stores stamp the broker at save.
 *   3. Reads are scoped: another broker's run is invisible, and by-id reads
 *      answer null — invisibility reads exactly like absence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  InMemoryDiscoveryRunStore,
} from "../src/data/inMemoryDiscoveryRunAdapter";
import { normalizeDiscoveryRunBroker } from "../src/data/discoveryRunPorts";

function input(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-05T12:00:00.000Z",
    trigger: "scheduled" as const,
    userLogin: "user@example.com",
    inputModel: "no-view" as const,
    requests: [],
    constraintSets: [{ id: "cs-1", minProbabilityOfProfit: 0.4 }],
    outcomes: [],
    status: "completed" as const,
    ...overrides,
  };
}

describe("discovery provenance normalizes legacy rows to E*TRADE (#3388)", () => {
  it("treats an absent or unknown broker as etrade", () => {
    expect(normalizeDiscoveryRunBroker(undefined)).toBe("etrade");
    expect(normalizeDiscoveryRunBroker(null)).toBe("etrade");
    expect(normalizeDiscoveryRunBroker("")).toBe("etrade");
    expect(normalizeDiscoveryRunBroker("interactive-brokers")).toBe("etrade");
  });

  it("keeps alpaca as alpaca", () => {
    expect(normalizeDiscoveryRunBroker("alpaca")).toBe("alpaca");
  });
});

describe("the store stamps and scopes by broker (#3388)", () => {
  it("stamps the run's broker at save", async () => {
    const store = new InMemoryDiscoveryRunStore();
    const run = await store.save(input({ broker: "alpaca" }) as never);
    expect(run.broker).toBe("alpaca");
  });

  it("a legacy save without a broker reads as etrade", async () => {
    const store = new InMemoryDiscoveryRunStore();
    const run = await store.save(input() as never);
    expect(run.broker).toBe("etrade");
  });

  it("lists only the requested broker's runs", async () => {
    const store = new InMemoryDiscoveryRunStore();
    await store.save(input({ broker: "alpaca" }) as never);
    await store.save(input({ broker: "etrade" }) as never);

    const alpaca = await store.list({ userLogin: "user@example.com", broker: "alpaca" });
    const etrade = await store.list({ userLogin: "user@example.com", broker: "etrade" });

    expect(alpaca).toHaveLength(1);
    expect(etrade).toHaveLength(1);
    expect(alpaca[0].id).not.toBe(etrade[0].id);
    expect(alpaca[0].broker).toBe("alpaca");
    expect(etrade[0].broker).toBe("etrade");
  });

  it("an unscoped list still returns both", async () => {
    const store = new InMemoryDiscoveryRunStore();
    await store.save(input({ broker: "alpaca" }) as never);
    await store.save(input({ broker: "etrade" }) as never);
    expect(await store.list({ userLogin: "user@example.com" })).toHaveLength(2);
  });

  it("by-id reads answer null for another broker", async () => {
    const store = new InMemoryDiscoveryRunStore();
    const run = await store.save(input({ broker: "alpaca" }) as never);

    expect(await store.get(run.id, { userLogin: "user@example.com", broker: "alpaca" })).not.toBeNull();
    expect(await store.get(run.id, { userLogin: "user@example.com", broker: "etrade" })).toBeNull();
  });
});

describe("the read routes scope by the resolved broker (#3388)", () => {
  it("passes the broker to both store reads", () => {
    const source = readFileSync("src/agents/routes/etradeOptionsRuns.ts", "utf8");
    expect(source).toContain("store.list({ limit, offset, userLogin, broker })");
    expect(source).toContain("{ userLogin, broker }");
  });

  it("stamps the broker on every persisted run", () => {
    const source = readFileSync("src/services/scheduledTasks.ts", "utf8");
    const stamps = source.match(/broker: await resolveTenantBroker\(this\.env\)/g) ?? [];
    // saved-request, profile-derived, no-view.
    expect(stamps).toHaveLength(3);
  });
});
