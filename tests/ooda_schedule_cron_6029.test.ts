/**
 * Issue #6029 (b) (sub-issue #6299) — the dead `research.scheduleCron` is
 * removed, and the settings API refuses undeclared keys by name.
 *
 * Why this pin exists: the filter editor advertised a "Daily schedule (cron)"
 * setting that nothing read — an editable control that lies about when the
 * nightly run fires. It was four sites in `src/services/researchConfig.ts` and
 * no reader anywhere. Removing a *dead* setting removes nothing that fires, so
 * it goes first, before the rider retirement that waits on the stored schedule
 * (#6298).
 *
 * The second half — `save()` refusing keys that are not research settings — is
 * what stops the next dead key from being born: today any key in the request
 * body is persisted (`this.store.set(this.keyFor(key), raw)`), so a typo
 * silently writes a setting no reader will ever see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RESEARCH_CONFIG_DEFAULTS,
  RESEARCH_CONFIG_SCHEMA,
  RESEARCH_CONFIG_RETIRED_KEYS,
  ResearchConfigService,
  validateResearchConfig,
  type ResearchConfig,
} from "../src/services/researchConfig";

function memoryStore(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    store: {
      get: (key: string) => map.get(key) ?? null,
      set: (key: string, value: string) => void map.set(key, value),
    },
  };
}

describe("#6029 (b) — research.scheduleCron is gone (#6299)", () => {
  it("P1: no declaration survives — not a default, not a schema row, not a validated field", () => {
    expect(Object.keys(RESEARCH_CONFIG_DEFAULTS)).not.toContain("scheduleCron");
    expect(RESEARCH_CONFIG_SCHEMA.map((f) => f.key)).not.toContain("scheduleCron");
    // The retirement is recorded, with its reason, in one place.
    expect(RESEARCH_CONFIG_RETIRED_KEYS.scheduleCron).toMatch(/#6029/);
    // Validation cannot fail on a field that no longer exists.
    const errors = validateResearchConfig({ ...RESEARCH_CONFIG_DEFAULTS });
    expect(errors).toEqual([]);
  });

  it("P2: a stored value is ignored, never read — the load is clean and carries no field", () => {
    const { store } = memoryStore({ "research.scheduleCron": "0 22 * * 1-5" });
    const config = new ResearchConfigService(store).load();
    expect("scheduleCron" in config).toBe(false);
    expect(config).toEqual(RESEARCH_CONFIG_DEFAULTS);
  });

  it("P3: naming the retired key in a save is refused by name, and nothing is written", () => {
    const { map, store } = memoryStore();
    const service = new ResearchConfigService(store);
    const out = service.save({ scheduleCron: "0 22 * * 1-5" } as unknown as Partial<ResearchConfig>);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/scheduleCron/);
    expect(out.errors[0]).toMatch(/retired/i);
    expect(out.errors[0]).toMatch(/#6029/);
    expect(map.has("research.scheduleCron")).toBe(false);
  });

  it("P4: an undeclared key is refused by name — a typo can no longer persist a setting", () => {
    const { map, store } = memoryStore();
    const service = new ResearchConfigService(store);
    const out = service.save({ marketCapMin: 6_000_000_000, maxIdea: 3 } as unknown as Partial<ResearchConfig>);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/maxIdea/);
    // Atomic: the valid half of the patch is not written either.
    expect(map.size).toBe(0);
    expect(out.config.marketCapMin).toBe(RESEARCH_CONFIG_DEFAULTS.marketCapMin);
  });

  it("P5: a valid patch still saves and reloads", () => {
    const { store } = memoryStore();
    const service = new ResearchConfigService(store);
    const out = service.save({ maxIdeas: 7 });
    expect(out.errors).toEqual([]);
    expect(out.config.maxIdeas).toBe(7);
    expect(new ResearchConfigService(store).load().maxIdeas).toBe(7);
  });

  it("P6: the report snapshot carries no scheduleCron key", () => {
    const { store } = memoryStore();
    const service = new ResearchConfigService(store);
    const config = service.load();
    const snapshot = service.snapshot(config);
    expect("scheduleCron" in snapshot).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("scheduleCron");
  });

  it("P7: no source file mentions it again — the grep pin that keeps the lie from returning", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("scheduleCron")) hits.push(full);
      }
    };
    walk("src");
    // The retirement record in researchConfig.ts is the one allowed mention.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((file) => file.endsWith("researchConfig.ts"))).toBe(true);
  });
});
