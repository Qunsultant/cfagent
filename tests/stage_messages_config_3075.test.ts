/**
 * Issue #3075 - coded stage messages, externalized stage config, one advice
 * pass per stage. Three properties are worth pinning, and each one exists
 * because the prose-only version of this could not be trusted:
 *
 *   1. every dead-letter reason the consumer emits carries a code from the
 *      closed catalog (so failures can be counted and alerted on);
 *   2. the config refuses a bad environment value instead of silently
 *      falling back to defaults (a typo'd budget must not look healthy);
 *   3. the advice pass never changes a stage's result or swallows its error.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STAGE_CONFIG,
  STAGE_MESSAGE_CATALOG,
  STAGE_MESSAGE_CODES,
  StageConfigError,
  formatStageMessage,
  maxAttemptsForStage,
  resolveStageConfig,
} from "../src/workflows/stageConfig";
import { describeStageAdvice, withStageAdvice } from "../src/workflows/stageAdvice";

describe("coded stage messages (#3075 R7)", () => {
  it("the catalog covers the closed code set, with remediation for each", () => {
    for (const code of STAGE_MESSAGE_CODES) {
      const meta = STAGE_MESSAGE_CATALOG[code];
      expect(meta.text.length).toBeGreaterThan(10);
      expect(meta.remediation.length).toBeGreaterThan(10);
    }
    expect(Object.keys(STAGE_MESSAGE_CATALOG).sort()).toEqual([...STAGE_MESSAGE_CODES].sort());
  });

  it("renders the code first, so grep finds every stage failure", () => {
    const line = formatStageMessage("STAGE_RETRY_EXHAUSTED", "attempt 4 exceeds maxAttempts 3");
    expect(line.startsWith("STAGE_RETRY_EXHAUSTED: ")).toBe(true);
    expect(line).toContain("attempt 4 exceeds maxAttempts 3");
  });

  it("every dead-letter path in the consumer emits a catalogued code", () => {
    const source = readFileSync("src/workflows/stageReportConsumer.ts", "utf8");
    const emitted = [...source.matchAll(/formatStageMessage\(\s*"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    for (const code of emitted) expect(STAGE_MESSAGE_CODES).toContain(code);
    // No raw prose dead-letter may sneak back in.
    expect(source).not.toMatch(/deadLetter\(\s*`/);
    expect(source).not.toMatch(/deadLetter\(\s*"/);
  });
});

describe("externalized stage config (#3075 R7)", () => {
  it("defaults are used when the environment says nothing", () => {
    expect(resolveStageConfig({})).toEqual(DEFAULT_STAGE_CONFIG);
    expect(DEFAULT_STAGE_CONFIG.maxAttempts).toBe(3);
  });

  it("a per-stage override wins over the base", () => {
    const config = resolveStageConfig({
      WORKFLOW_STAGE_MAX_ATTEMPTS: "5",
      WORKFLOW_STAGE_MAX_ATTEMPTS__ANALYSIS_DONE: "2",
    });
    expect(maxAttemptsForStage(config, "analysis-done")).toBe(2);
    expect(maxAttemptsForStage(config, "fetchQuotes")).toBe(5);
  });

  it("a bad value is refused, not silently defaulted", () => {
    for (const bad of ["0", "-1", "two", "1.5"]) {
      expect(() => resolveStageConfig({ WORKFLOW_STAGE_MAX_ATTEMPTS: bad })).toThrow(StageConfigError);
    }
    try {
      resolveStageConfig({ WORKFLOW_STAGE_MAX_ATTEMPTS: "0" });
    } catch (error) {
      expect((error as StageConfigError).code).toBe("STAGE_CONFIG_INVALID");
      expect((error as Error).message).toContain("STAGE_CONFIG_INVALID");
    }
  });
});

describe("one advice pass per stage (#3075 AOP)", () => {
  it("returns the body's result untouched on success", async () => {
    const events: string[] = [];
    const result = await withStageAdvice({
      stageId: "analysis-done",
      log: (event) => events.push(event.outcome),
      run: async () => 42,
    });
    expect(result).toBe(42);
    expect(events).toEqual(["ok"]);
  });

  it("rethrows the original error and records the coded verdict", async () => {
    const seen: unknown[] = [];
    const boom = new Error("persisted analysis missing");
    await expect(
      withStageAdvice({
        stageId: "analysis-done",
        log: (event) => seen.push(event),
        run: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    const event = seen[0] as { outcome: string; code: string; durationMs: number };
    expect(event.outcome).toBe("failed");
    expect(event.code).toBe("STAGE_PERSISTED_MISSING");
    expect(typeof event.durationMs).toBe("number");
  });

  it("describes an event in one line an operator can paste", () => {
    expect(
      describeStageAdvice({ stageId: "deliver", outcome: "ok", durationMs: 12 }),
    ).toBe("stage deliver ok in 12ms");
    expect(
      describeStageAdvice({
        stageId: "analysis-done",
        outcome: "failed",
        durationMs: 7,
        code: "STAGE_RETRY_EXHAUSTED",
        detail: "attempt 4 exceeds maxAttempts 3",
      }),
    ).toContain("STAGE_RETRY_EXHAUSTED");
  });

  it("the advice is side-effect free when no logger is supplied", async () => {
    const spy = vi.fn();
    await withStageAdvice({ stageId: "plan", run: async () => spy() });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
