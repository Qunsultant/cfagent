/**
 * Issue #5976 — the chat/MCP config controls.
 *
 * One command (`research_config`) over the orchestrator's config door, which
 * delegates to the research agent's `ResearchConfigService` — the same store,
 * validation and refusals the settings page and `POST /api/research/settings`
 * use. What this file pins:
 *
 *  M1  no acting identity refuses before any door call (fail closed);
 *  M2  `update` without a patch refuses by name and writes nothing;
 *  M3  `get` / `update` reach the ONE door with the acting login, and an update
 *      forwards exactly the keys the caller named.
 */
import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";
import type { McpToolContext } from "../src/patterns/interfaces";
import { ResearchConfigCommand } from "../src/mcps/openaimp/researchJobCommands";

function context(actingLogin: string | null, door: (login?: string, patch?: Record<string, unknown>) => Promise<unknown>) {
  const audit = vi.fn();
  const env = {
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ researchConfigForMcp: door }),
    },
  } as unknown as Env;
  return {
    ctx: {
      env,
      orm: {} as never,
      sessionId: "s",
      audit,
      actingLogin: () => actingLogin ?? undefined,
    } as unknown as McpToolContext,
    audit,
  };
}

describe("#5976 — research_config over the one config service", () => {
  const command = new ResearchConfigCommand();

  it("M1: refuses with no acting identity, before any door call", async () => {
    const door = vi.fn();
    const { ctx } = context(null, door);
    await expect(command.execute({ action: "get" }, ctx)).rejects.toThrow(
      /FAILURE_RESEARCH_OWNER_MISSING/,
    );
    expect(door).not.toHaveBeenCalled();
  });

  it("M2: an update with no patch refuses by name", async () => {
    const door = vi.fn();
    const { ctx } = context("owner", door);
    await expect(command.execute({ action: "update" }, ctx)).rejects.toThrow(
      /research_config_patch_missing/,
    );
    expect(door).not.toHaveBeenCalled();
  });

  it("M3: get and update reach the door with the acting login", async () => {
    const calls: Array<{ login?: string; patch?: Record<string, unknown> }> = [];
    const door = async (login?: string, patch?: Record<string, unknown>) => {
      calls.push({ login, patch });
      return { rulesVersion: "1.0.0", config: { universe: "sp500" } };
    };
    const { ctx, audit } = context("owner", door);
    const read = await command.execute({ action: "get" }, ctx);
    expect(read).toMatchObject({ rulesVersion: "1.0.0" });
    const written = await command.execute(
      { action: "update", patch: { universe: "nasdaq" } },
      ctx,
    );
    expect(written).toMatchObject({ config: { universe: "sp500" } });
    expect(calls).toEqual([
      { login: "owner", patch: undefined },
      { login: "owner", patch: { universe: "nasdaq" } },
    ]);
    expect(audit).toHaveBeenCalledTimes(2);
  });
});
