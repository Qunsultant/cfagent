/**
 * Issue #4202 — Durable Object duration.
 *
 * Cloudflare's finding on #4202: DO duration bills wall-clock time while
 * an object is running or resident-but-unable-to-hibernate. The
 * account's largest contributor was handlers that run for seconds to
 * minutes at a time, and the sharpest instance in this codebase was the
 * chat screen/payment await: a poll loop held inside the
 * OrchestratorAgent request for up to FIFTEEN MINUTES, per run, twice
 * over (the mesh door and the NLQ port carry the same loop).
 *
 * The fix is a single shared budget: one constant pair, one resolver, a
 * hard ceiling on the default, and no way for configuration to put the
 * fifteen-minute wait back. These tests pin the budget and pin the two
 * call sites to it, because the failure mode being guarded is a copied
 * literal quietly restoring the old window.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAT_AWAIT_BUDGET_ENV_KEY,
  CHAT_AWAIT_POLL_INTERVAL_MS,
  DEFAULT_CHAT_AWAIT_DEADLINE_MS,
  MAX_CHAT_AWAIT_DEADLINE_MS,
  MIN_CHAT_AWAIT_DEADLINE_MS,
  resolveChatAwaitDeadlineMs,
} from "../src/agents/orchestrator/chatAwaitBudget";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

describe("chat await budget (#4202 — DO duration)", () => {
  it("defaults to two minutes, not the fifteen-minute window it replaces", () => {
    expect(DEFAULT_CHAT_AWAIT_DEADLINE_MS).toBe(120_000);
    expect(MAX_CHAT_AWAIT_DEADLINE_MS).toBe(DEFAULT_CHAT_AWAIT_DEADLINE_MS);
    expect(MIN_CHAT_AWAIT_DEADLINE_MS).toBe(5_000);
    expect(resolveChatAwaitDeadlineMs(undefined)).toBe(120_000);
    expect(resolveChatAwaitDeadlineMs({})).toBe(120_000);
  });

  it("keeps the poll cadence unchanged (the budget moves, the cadence does not)", () => {
    expect(CHAT_AWAIT_POLL_INTERVAL_MS).toBe(2_000);
  });

  it("lets an operator shorten it", () => {
    expect(resolveChatAwaitDeadlineMs({ [CHAT_AWAIT_BUDGET_ENV_KEY]: "30000" })).toBe(30_000);
    expect(resolveChatAwaitDeadlineMs({ [CHAT_AWAIT_BUDGET_ENV_KEY]: 45_000 })).toBe(45_000);
    // Below the floor still resolves to the floor, never to "wait forever".
    expect(resolveChatAwaitDeadlineMs({ [CHAT_AWAIT_BUDGET_ENV_KEY]: "1" })).toBe(5_000);
  });

  it("never lets configuration restore the long window", () => {
    expect(resolveChatAwaitDeadlineMs({ [CHAT_AWAIT_BUDGET_ENV_KEY]: "900000" })).toBe(120_000);
    expect(resolveChatAwaitDeadlineMs({ [CHAT_AWAIT_BUDGET_ENV_KEY]: "999999999999" })).toBe(120_000);
  });

  it("falls back to the default on anything unusable", () => {
    for (const bad of ["", "  ", "abc", "0", "-1", "NaN", "Infinity", null, undefined, {}]) {
      expect(resolveChatAwaitDeadlineMs({ [CHAT_AWAIT_BUDGET_ENV_KEY]: bad })).toBe(120_000);
    }
  });

  it("is the only budget the two await loops carry (no copied literal can restore 15 minutes)", () => {
    for (const file of [
      "src/agents/orchestrator/meshScreenDoor.ts",
      "src/agents/orchestrator/nlqPorts.ts",
    ]) {
      const src = read(file);
      expect(src).toContain("resolveChatAwaitDeadlineMs");
      expect(src).not.toContain("15 * 60_000");
      expect(src).not.toMatch(/AWAIT_DEADLINE_MS\s*=\s*15/);
    }
    expect(read("src/agents/orchestrator/meshScreenDoor.ts")).not.toContain(
      "SCREEN_DOOR_AWAIT_DEADLINE_MS =",
    );
    expect(read("src/agents/orchestrator/nlqPorts.ts")).not.toContain(
      "CHAT_SCREEN_AWAIT_DEADLINE_MS =",
    );
  });
});

describe("no no-op keep-alive timer (#4202)", () => {
  it("keepAlive() hands back a disposer without arming a timer", async () => {
    const { ETradeDurableFiberService } = await import("../src/services/durableFibers");
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const service = new ETradeDurableFiberService();
      const before = vi.getTimerCount();
      const dispose = await service.keepAlive();
      expect(vi.getTimerCount()).toBe(before);
      dispose();
      dispose(); // idempotent, as before
    } finally {
      vi.useRealTimers();
    }
  });
});
