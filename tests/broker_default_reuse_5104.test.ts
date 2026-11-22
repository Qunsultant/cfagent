import { describe, it, expect, vi } from "vitest";
import {
  defaultBrokerId,
  defaultTradingMode,
  environmentForTradingType,
} from "../src/trading/brokerCatalog";
import { TradingPlatformRegistry } from "../src/trading";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import {
  resolveScreenSelection,
  type ScreenSelectionReaders,
  type TenantBrokerSelectionRead,
} from "../src/services/providerConnections";
import {
  resolveGoalLegHostDispatch,
} from "../src/services/goalLegHostDispatch";
import type { Env } from "../src/types";
import type { UniverseDepsStageInput } from "../src/workflows/optionsStepPorts";

/**
 * Issue #5104 (DEFAULT part of B1) — the job paths reuse the EXISTING
 * broker/mode default instead of refusing on an unconfigured tenant.
 *
 * The default already exists: `config/vocabulary.json` defaults
 * (alpaca/paper), `vocabularyDefaults()` (#5516), `defaultBrokerId()`,
 * and `resolveTenantBroker` (#3937). The job paths that read through
 * the presence-aware seam `readTenantBrokerSelection` refused on
 * `unconfigured` instead of consulting it. These tests pin the reuse
 * fallback: `unconfigured` resolves to the existing alpaca/paper
 * default; a genuine store failure still refuses by name.
 */

const tenant = {
  selection: (): TenantBrokerSelectionRead =>
    ({ status: "ok", brokerId: "alpaca" }) as TenantBrokerSelectionRead,
};

vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return { ...actual, readTenantBrokerSelection: async () => tenant.selection() };
});

function screenReaders(
  overrides: Partial<ScreenSelectionReaders> = {},
): ScreenSelectionReaders {
  return {
    env: {},
    userLogin: "alice",
    commercial: {
      getTenantBrokerSelection: async () => "alpaca",
    },
    hasCredentials: async () => true,
    listAccounts: async () => ["acct-1"],
    ...overrides,
  };
}

const GOAL_RUN_ID = "goal-screen:test-key-5104";
const UNIVERSE_INPUT: UniverseDepsStageInput = { provider: "nasdaq" };

function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AGENT_DB: {},
    JOB_PIPELINE_WORKFLOW: {
      create: async () => ({ id: "never-created" }),
    },
    ...extra,
  } as unknown as Env;
}

describe("brokerCatalog — the vocabulary default, read not rebuilt", () => {
  it("defaultBrokerId() is the vocabulary default broker (alpaca)", () => {
    expect(defaultBrokerId()).toBe("alpaca");
  });

  it("defaultTradingMode() is the vocabulary default mode (paper)", () => {
    expect(defaultTradingMode()).toBe("paper");
  });

  it("environmentForTradingType inverts the catalog mapping", () => {
    expect(environmentForTradingType("alpaca", "paper")).toBe("TEST");
    expect(environmentForTradingType("alpaca", "live")).toBe("PROD");
    expect(environmentForTradingType("etrade", "paper")).toBe("TEST");
    expect(environmentForTradingType("etrade", "live")).toBe("PROD");
  });
});

describe("resolveScreenSelection — unconfigured falls back to the existing default", () => {
  it("resolves alpaca/paper when no broker selection is stored — never a refusal", async () => {
    const result = await resolveScreenSelection(
      screenReaders({
        commercial: { getTenantBrokerSelection: async () => null },
      }),
    );
    expect(result).toEqual({
      resolved: true,
      selection: {
        connectionId: "alpaca:TEST:alice",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "acct-1",
      },
    });
  });

  it("resolves alpaca/paper for a stored broker id that is not a known broker", async () => {
    const result = await resolveScreenSelection(
      screenReaders({
        commercial: { getTenantBrokerSelection: async () => "fidelity" },
      }),
    );
    expect(result).toEqual({
      resolved: true,
      selection: {
        connectionId: "alpaca:TEST:alice",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "acct-1",
      },
    });
  });

  it("still refuses STORE_UNAVAILABLE when the selection read throws — never fail-open", async () => {
    const result = await resolveScreenSelection(
      screenReaders({
        commercial: {
          getTenantBrokerSelection: async () => {
            throw new Error("D1 down");
          },
        },
      }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "STORE_UNAVAILABLE",
      error: expect.stringContaining("could not be read"),
    });
  });

  it("a stored alpaca selection still resolves alpaca/paper (ok path unchanged)", async () => {
    const result = await resolveScreenSelection(
      screenReaders({
        commercial: { getTenantBrokerSelection: async () => "alpaca" },
        readSettingRaw: () => "TEST",
      }),
    );
    expect(result).toEqual({
      resolved: true,
      selection: {
        connectionId: "alpaca:TEST:alice",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "acct-1",
      },
    });
  });
});

describe("UnifiedOptionsService.resolveEngineClient — unconfigured falls back to alpaca", () => {
  it("returns the alpaca chain source when the tenant has not configured a broker", async () => {
    tenant.selection = () =>
      ({
        status: "unconfigured",
        error: "no broker selection: the tenant has not configured a broker",
      }) as TenantBrokerSelectionRead;
    const service = new UnifiedOptionsService(
      {} as never,
      "test-user@example.com",
      "PAPER",
    );
    const result = await service.resolveEngineClient();
    expect(result.engineClient).toBeDefined();
    expect(result.platformRunId).toBeUndefined();
  });

  it("still throws with a named error when the broker selection store is unavailable", async () => {
    tenant.selection = () =>
      ({
        status: "store_unavailable",
        error: "broker selection could not be read: tenant store failed",
      }) as TenantBrokerSelectionRead;
    const service = new UnifiedOptionsService(
      {} as never,
      "test-user@example.com",
      "PAPER",
    );
    await expect(service.resolveEngineClient()).rejects.toThrow(
      /broker selection could not be read/,
    );
  });

  it("a stored alpaca selection still resolves the alpaca chain source (ok path unchanged)", async () => {
    tenant.selection = () =>
      ({ status: "ok", brokerId: "alpaca" }) as TenantBrokerSelectionRead;
    const service = new UnifiedOptionsService(
      {} as never,
      "test-user@example.com",
      "PAPER",
    );
    const result = await service.resolveEngineClient();
    expect(result.engineClient).toBeDefined();
  });
});

describe("resolveGoalLegHostDispatch — unconfigured falls back to alpaca/paper", () => {
  const gate = {
    goalRunId: GOAL_RUN_ID,
    hasSymbols: true,
    universe: UNIVERSE_INPUT,
  };

  it("derives the alpaca/paper pair and routes to the host when unconfigured", async () => {
    const { decision, broker } = await resolveGoalLegHostDispatch(
      boundEnv(),
      undefined,
      gate,
      async () => ({ status: "unconfigured", error: "no selection" }),
    );
    expect(broker).toEqual({ broker: "alpaca", mode: "paper" });
    expect(decision.route).toBe("host");
  });

  it("still yields no pair and the sync decision when the store is unavailable", async () => {
    const { decision, broker } = await resolveGoalLegHostDispatch(
      boundEnv(),
      undefined,
      gate,
      async () => ({ status: "store_unavailable", error: "store down" }),
    );
    expect(broker).toBeNull();
    expect(decision.route).toBe("sync");
  });

  it("a stored alpaca selection still derives the alpaca pair (ok path unchanged)", async () => {
    const { decision, broker } = await resolveGoalLegHostDispatch(
      boundEnv(),
      undefined,
      gate,
      async () => ({ status: "ok", brokerId: "alpaca" }),
    );
    expect(broker).toEqual({ broker: "alpaca", mode: "paper" });
    expect(decision.route).toBe("host");
  });
});

// Referenced so the barrel registration side effect is explicit in this file.
void TradingPlatformRegistry;
