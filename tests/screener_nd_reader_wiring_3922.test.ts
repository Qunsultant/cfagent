/**
 * Issue #3922 — the screener ND gate's stored layer, wired into
 * its production hosts (follow-on of #3741).
 *
 * #3741 gave the `screenerNdMode` entry of the one resolver a
 * stored layer (mas_settings `screener_nd_mode:<class>`, then the
 * bare key) but the gate's production hosts never supplied a
 * settings reader, so the layer was inert: every host resolved
 * env-only. This suite pins the wiring contract:
 *
 * - A host that supplies a reader resolves through the full
 *   layered entry: a stored value flips the gate with source
 *   "stored", no code change.
 * - A host whose reader finds no stored value resolves
 *   byte-identically to the env-only resolution (the production
 *   behavior until an operator writes the setting).
 * - The mesh screen door (built from an McpToolContext) refuses
 *   or admits ND by the stored value, before any workflow start.
 * - The REST admission helpers and the workflow-start backstop
 *   take the reader as an optional carrier; without one they
 *   behave exactly as the #2530 suites pin.
 */

import { describe, expect, it } from "vitest";
import {
  resolveScreenerNdGateForHost,
  resolveScreenerNdGateFromEnv,
  SCREENER_ND_AGENT_CLASS,
  screenerNdModeSettingKey,
} from "../src/config/screenerModes";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  meshScreenDoorContextFromMcp,
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
} from "../src/agents/orchestrator/meshScreenDoor";
import {
  admitScreenModeSelection,
  screenModeSelectionFromFields,
  tryStartScreenerWorkflow,
} from "../src/workflows/screenerWorkflowRoutes";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type { WorkflowPort } from "../src/workflows/workflowPorts";
import type { McpToolContext } from "../src/patterns/interfaces";
import { MockSqlStorage } from "./mock-sql";

const ND_INTENT = "momentum names with improving earnings";

/** A settings reader over a plain record (the mas_settings shape). */
function readerFrom(values: Record<string, string>): (key: string) => string | null {
  return (key) => values[key] ?? null;
}

/* ------------------------------------------------------------------ */
/* The host gate helper: full layered resolution, source named         */
/* ------------------------------------------------------------------ */

describe("resolveScreenerNdGateForHost (#3922)", () => {
  it("a stored value flips the gate with source \"stored\" — env on, stored off refuses", () => {
    const resolved = resolveScreenerNdGateForHost({
      env: { SCREENER_ND_MODE: "on" },
      readSettingRaw: readerFrom({ [screenerNdModeSettingKey(SCREENER_ND_AGENT_CLASS)]: "off" }),
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.source).toBe("stored");
  });

  it("a stored value flips the gate the other way — env unset, stored on admits", () => {
    const resolved = resolveScreenerNdGateForHost({
      env: {},
      readSettingRaw: readerFrom({ screener_nd_mode: "on" }),
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.source).toBe("stored");
  });

  it("the class-scoped stored key wins over the bare tenant key", () => {
    const resolved = resolveScreenerNdGateForHost({
      env: {},
      readSettingRaw: readerFrom({
        screener_nd_mode: "on",
        [screenerNdModeSettingKey(SCREENER_ND_AGENT_CLASS)]: "off",
      }),
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.source).toBe("stored");
  });

  it("no stored value → byte-identical to the env-only resolution, across the env matrix", () => {
    const envs: Array<Record<string, unknown>> = [
      {},
      { SCREENER_ND_MODE: "on" },
      { SCREENER_ND_MODE: "off" },
      { SCREENER_ND_MODE: "banana" },
      { SCREENER_ND_MODE: " ON " },
      { SCREENER_ND_MODE: "" },
    ];
    for (const env of envs) {
      const viaHost = resolveScreenerNdGateForHost({ env, readSettingRaw: () => null });
      const envOnly = resolveScreenerNdGateFromEnv(env);
      expect({ enabled: viaHost.enabled, invalid: viaHost.invalid, raw: viaHost.raw }).toEqual(envOnly);
      const withoutReader = resolveScreenerNdGateForHost({ env });
      expect({ enabled: withoutReader.enabled, invalid: withoutReader.invalid, raw: withoutReader.raw }).toEqual(envOnly);
    }
  });

  it("a malformed stored value never enables and never blocks the env layer", () => {
    const resolved = resolveScreenerNdGateForHost({
      env: { SCREENER_ND_MODE: "on" },
      readSettingRaw: readerFrom({ screener_nd_mode: "banana" }),
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.source).toBe("env");
  });
});

/* ------------------------------------------------------------------ */
/* The mesh screen door: the reader rides the tool context             */
/* ------------------------------------------------------------------ */

interface DoorHarness {
  started: WorkflowJobCommand[];
  ctx: MeshScreenDoorContext;
}

function makeDoorHarness(
  env: Record<string, unknown>,
  readSettingRaw?: (key: string) => string | null,
): DoorHarness {
  const started: WorkflowJobCommand[] = [];
  const port: WorkflowPort = {
    start: async (command) => {
      started.push(command);
      return {
        workflowId: `screen-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        existing: false,
        statusUrl: `/api/jobs/history?chainId=${encodeURIComponent(command.jobId)}`,
      };
    },
    status: async () => ({ status: "complete" }),
  };
  const sql = new MockSqlStorage();
  const ctx: MeshScreenDoorContext = {
    env: env as MeshScreenDoorContext["env"],
    ensureTables: () => sql as never,
    workflowPort: port,
    readWorkflowJobHistory: async (_tenantId, chainId) => [
      {
        jobKey: chainId,
        resultJson: JSON.stringify({
          jobId: chainId,
          workflowId: `screen-${chainId}`,
          lifecycle: "Failed",
          qualified: false,
          coverage: { evaluated: 0, considered: 0, ratio: null },
          shards: [],
          lifecycleTransitions: [],
          stageTransitions: [],
          reportKeys: [],
          storedShards: [],
          deliveredShards: [],
          error: "test collation",
        }),
      } as never,
    ],
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 5_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    ...(readSettingRaw ? { readSettingRaw } : {}),
  };
  return { started, ctx };
}

describe("mesh screen door ND gate with a settings reader (#3922)", () => {
  it("stored off refuses an ND request even while the env flag is on — before any start", async () => {
    const h = makeDoorHarness(
      { SCREENER_ND_MODE: "on" },
      readerFrom({ [screenerNdModeSettingKey(SCREENER_ND_AGENT_CLASS)]: "off" }),
    );
    await expect(
      runStockScreenViaDoor(h.ctx, "alice", {
        screenMode: "non-deterministic",
        screenIntent: ND_INTENT,
      }),
    ).rejects.toMatchObject({ code: "nd_mode_unavailable" });
    expect(h.started).toHaveLength(0);
  });

  it("stored on admits an ND request while the env flag is unset", async () => {
    const h = makeDoorHarness({}, readerFrom({ screener_nd_mode: "on" }));
    await runStockScreenViaDoor(h.ctx, "alice", {
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    });
    expect(h.started).toHaveLength(1);
    expect(h.started[0].screenMode).toBe("non-deterministic");
  });

  it("a reader that finds nothing leaves the env resolution exactly as today", async () => {
    const on = makeDoorHarness({ SCREENER_ND_MODE: "on" }, () => null);
    await runStockScreenViaDoor(on.ctx, "alice", {
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    });
    expect(on.started).toHaveLength(1);

    const off = makeDoorHarness({}, () => null);
    await expect(
      runStockScreenViaDoor(off.ctx, "alice", {
        screenMode: "non-deterministic",
        screenIntent: ND_INTENT,
      }),
    ).rejects.toMatchObject({ code: "nd_mode_unavailable" });
    expect(off.started).toHaveLength(0);
  });

  it("the door context built from a tool context carries the tool context's reader", async () => {
    const readSettingRaw = readerFrom({
      [screenerNdModeSettingKey(SCREENER_ND_AGENT_CLASS)]: "off",
    });
    const sql = new MockSqlStorage();
    const toolContext = {
      env: { SCREENER_ND_MODE: "on" },
      orm: undefined,
      sessionId: "session-3922",
      storage: { sql },
      audit: () => {},
      readSettingRaw,
    } as unknown as McpToolContext;
    const doorCtx = meshScreenDoorContextFromMcp(toolContext);
    expect(doorCtx.readSettingRaw).toBe(readSettingRaw);
    // And the carried reader actually governs the door's gate.
    const harness = makeDoorHarness({ SCREENER_ND_MODE: "on" }, doorCtx.readSettingRaw);
    await expect(
      runStockScreenViaDoor(harness.ctx, "alice", {
        screenMode: "non-deterministic",
        screenIntent: ND_INTENT,
      }),
    ).rejects.toBeInstanceOf(MeshDoorError);
    expect(harness.started).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The REST admission helpers + the workflow-start backstop            */
/* ------------------------------------------------------------------ */

describe("REST admission with a settings reader (#3922)", () => {
  it("stored off refuses an ND selection while the env flag is on", () => {
    const sel = screenModeSelectionFromFields(
      { SCREENER_ND_MODE: "on" },
      { screenMode: "non-deterministic", screenIntent: ND_INTENT },
      { readSettingRaw: readerFrom({ screener_nd_mode: "off" }) },
    );
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.error).toMatch(/SCREENER_ND_MODE/);
  });

  it("stored on admits an ND selection while the env flag is unset", () => {
    const sel = screenModeSelectionFromFields(
      {},
      { screenMode: "non-deterministic", screenIntent: ND_INTENT },
      { readSettingRaw: readerFrom({ screener_nd_mode: "on" }) },
    );
    expect(sel).toEqual({ ok: true, screenMode: "non-deterministic", screenIntent: ND_INTENT });
  });

  it("admitScreenModeSelection forwards the reader and still strips the body fields", () => {
    const body: { screenMode?: unknown; screenIntent?: unknown } = {
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    };
    const sel = admitScreenModeSelection(
      { SCREENER_ND_MODE: "on" },
      "POST",
      body,
      new URLSearchParams(),
      { readSettingRaw: readerFrom({ screener_nd_mode: "off" }) },
    );
    expect(sel.ok).toBe(false);
    expect(body.screenMode).toBeUndefined();
    expect(body.screenIntent).toBeUndefined();
  });
});

function ndCommand(): WorkflowJobCommand {
  return {
    jobId: "job-3922",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [{ shardId: "NASDAQ100", universe: "NASDAQ100" }],
    screenMode: "non-deterministic",
    screenIntent: ND_INTENT,
  } as WorkflowJobCommand;
}

describe("tryStartScreenerWorkflow backstop with a settings reader (#3922)", () => {
  it("stored off throws for an ND command even while the env flag is on", async () => {
    await expect(
      tryStartScreenerWorkflow({ SCREENER_ND_MODE: "on" } as never, ndCommand(), {
        readSettingRaw: readerFrom({ screener_nd_mode: "off" }),
      }),
    ).rejects.toThrow(/SCREENER_ND_MODE/);
  });

  it("stored on admits an ND command while the env flag is unset (port availability decides)", async () => {
    await expect(
      tryStartScreenerWorkflow({} as never, ndCommand(), {
        readSettingRaw: readerFrom({ screener_nd_mode: "on" }),
      }),
    ).resolves.toBeNull();
  });

  it("no reader → the env-only backstop, exactly as #2530 pins it", async () => {
    await expect(tryStartScreenerWorkflow({} as never, ndCommand())).rejects.toThrow(/SCREENER_ND_MODE/);
    await expect(
      tryStartScreenerWorkflow({ SCREENER_ND_MODE: "on" } as never, ndCommand()),
    ).resolves.toBeNull();
  });
});
