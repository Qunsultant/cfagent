/**
 * Issue #5056 (AG-2) — the Self-RSI mode switch must not offer a mode that
 * enables nothing.
 *
 * The RSI doc's §7 pipeline (research → sandbox synthesis → backtest →
 * StrategyCard → 1-click activation) is specified-only: no
 * `synthesizeStrategy`, no `StrategyCard`, no synthesis in the SandboxAgent.
 * `self` is therefore gated to `governed` with one notice, sourced from the
 * capability registry, and a door write of `self` is refused rather than
 * persisted.
 */
import { describe, it, expect } from "vitest";
import {
  SELF_RSI_PIPELINE_CAPABILITY,
  STOCK_COPILOT_RSI_CAPABILITIES,
  isSelfRsiPipelineImplemented,
  selfRsiModeNotice,
} from "../src/services/stockCopilotRsiCapabilities";
import {
  COPILOT_RSI_MODE_SETTING_KEY,
  resolveStockCopilotRsiMode,
  resolveStockCopilotRsiModeState,
} from "../src/services/stockCopilotRsiMode";
import { controlStockCopilotViaDoor } from "../src/agents/orchestrator/meshStockCopilotDoor";
import type { StockCopilotDoorContext } from "../src/agents/orchestrator/meshStockCopilotDoor";

describe("Issue #5056 — self-RSI mode gate", () => {
  it("states the §7 pipeline as specified-only, with what is missing", () => {
    const capability =
      STOCK_COPILOT_RSI_CAPABILITIES[SELF_RSI_PIPELINE_CAPABILITY];
    expect(capability).toBeDefined();
    expect(capability.status).toBe("specified_only");
    expect(capability.missing?.join(" ")).toContain("synthesizeStrategy");
    expect(capability.missing?.join(" ")).toContain("StrategyCard");
    expect(isSelfRsiPipelineImplemented()).toBe(false);
  });

  it("gates a stored `self` request to governed, with the notice", () => {
    const state = resolveStockCopilotRsiModeState({
      readSettingRaw: (key) =>
        key === COPILOT_RSI_MODE_SETTING_KEY ? "self" : null,
    });
    expect(state.requested).toBe("self");
    expect(state.effective).toBe("governed");
    expect(state.notice).toBe(selfRsiModeNotice());
    expect(state.notice).toContain("not implemented");
    expect(state.notice).toContain("§7");
    // The legacy accessor reports the mode in effect, never the request.
    expect(
      resolveStockCopilotRsiMode({
        readSettingRaw: (key) =>
          key === COPILOT_RSI_MODE_SETTING_KEY ? "self" : null,
      }),
    ).toBe("governed");
  });

  it("gates the env-declared `self` default too", () => {
    const state = resolveStockCopilotRsiModeState({
      env: { STOCK_COPILOT_RSI_MODE: "self" } as any,
    });
    expect(state.requested).toBe("self");
    expect(state.effective).toBe("governed");
    expect(state.notice).toBeTruthy();
  });

  it("leaves governed unresolved and unnoted", () => {
    const state = resolveStockCopilotRsiModeState({
      readSettingRaw: () => null,
      env: {} as any,
    });
    expect(state.requested).toBe("governed");
    expect(state.effective).toBe("governed");
    expect(state.notice).toBeNull();
  });

  it("refuses to persist `self` at the door, keeping the current mode", async () => {
    const settings = new Map<string, string>();
    const audits: Array<{ event: string; detail: unknown }> = [];
    const ctx = {
      user: { login: "trader_gate", email: "trader@example.com" },
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      writeSetting: (key: string, value: string) => settings.set(key, value),
      audit: (event: string, _actor: string, detail: unknown) =>
        audits.push({ event, detail }),
      env: {} as any,
      sql: { exec: () => [] } as any,
    } as unknown as StockCopilotDoorContext;

    const result = await controlStockCopilotViaDoor(ctx, "trader_gate", {
      rsiMode: "self",
    });

    expect(result.success).toBe(true);
    expect(result.rsiMode).toBe("governed");
    expect(result.rsiModeNotice).toBe(selfRsiModeNotice());
    // The switch did not move: no `self` was persisted.
    expect(settings.get(COPILOT_RSI_MODE_SETTING_KEY)).toBeUndefined();
    expect(
      audits.some((a) => a.event === "stock_copilot.control_rsi_mode_rejected"),
    ).toBe(true);
  });

  it("still persists an explicit governed selection", async () => {
    const settings = new Map<string, string>();
    const ctx = {
      user: { login: "trader_gate", email: "trader@example.com" },
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      writeSetting: (key: string, value: string) => settings.set(key, value),
      audit: () => {},
      env: {} as any,
      sql: { exec: () => [] } as any,
    } as unknown as StockCopilotDoorContext;

    const result = await controlStockCopilotViaDoor(ctx, "trader_gate", {
      rsiMode: "governed",
    });

    expect(result.success).toBe(true);
    expect(result.rsiMode).toBe("governed");
    expect(result.rsiModeNotice).toBeUndefined();
    expect(settings.get(COPILOT_RSI_MODE_SETTING_KEY)).toBe("governed");
  });
});
