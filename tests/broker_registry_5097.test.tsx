// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleAccountBindingRoutes } from "../src/agents/routes/accountBindings";
import { AccountBindingSelector } from "../src/client/AccountBindingSelector";
import { brokerOptionsFromRegistry } from "../src/client/brokerOptions";
import { BrokerAccountBindingCommand } from "../src/mcps/openaimp/accountBindingCommands";
import {
  applyBrokerRegistryPatch,
  buildDefaultBrokerAssetAccountRegistry,
  validateAccountBindingInput,
} from "../src/trading";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

let mountedContainer: HTMLDivElement | null = null;

afterEach(() => {
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
  vi.restoreAllMocks();
});

describe("Issue #5097 (Slice F0 of #5094) — Configurable broker / asset-type / account-type registry", () => {
  it("5097-P01: builds default registry from BROKER_CATALOG and supports adding/enabling/disabling brokers, asset types, and account types without code change", () => {
    const base = buildDefaultBrokerAssetAccountRegistry();
    expect(base.brokers.length).toBeGreaterThanOrEqual(5);
    expect(base.assetTypes).toContain("stock");
    expect(base.assetTypes).toContain("options");

    // Add a custom broker, custom asset type, and custom account type via config patch
    const step1 = applyBrokerRegistryPatch(
      base,
      {
        addAssetType: "fixed_income",
        addAccountType: "roth_401k",
        upsertBroker: {
          id: "prime_desk",
          label: "Prime Institutional Desk",
          icon: "🏛️",
          enabled: true,
          modes: ["live"],
          assetTypes: ["stock", "options", "fixed_income"],
          accountTypesByAsset: {
            fixed_income: ["roth_401k", "treasury_direct"],
          },
        },
      },
      "admin@example.com",
    );
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;

    expect(step1.registry.assetTypes).toContain("fixed_income");
    expect(step1.registry.accountTypes).toContain("roth_401k");
    expect(step1.registry.accountTypes).toContain("treasury_direct");
    const prime = step1.registry.brokers.find((b) => b.id === "prime_desk");
    expect(prime?.label).toBe("Prime Institutional Desk");
    expect(prime?.modes).toEqual(["live"]);

    // brokerOptionsFromRegistry includes the newly added broker
    const options = brokerOptionsFromRegistry(step1.registry);
    expect(options.map((o) => o.id)).toContain("prime_desk");

    // Binding against the custom broker + custom accountType succeeds in live mode and refuses paper mode
    const validBind = validateAccountBindingInput({
      broker: "prime_desk",
      mode: "live",
      accountType: "treasury_direct",
      scope: "autopilot",
      accountId: "PD-9001",
      registry: step1.registry,
    });
    expect(validBind.ok).toBe(true);

    const invalidMode = validateAccountBindingInput({
      broker: "prime_desk",
      mode: "paper",
      accountType: "treasury_direct",
      scope: "autopilot",
      accountId: "PD-9001",
      registry: step1.registry,
    });
    expect(invalidMode.ok).toBe(false);

    // Disabling the broker removes it from selectable options and refuses new bindings
    const step2 = applyBrokerRegistryPatch(step1.registry, {
      upsertBroker: { id: "prime_desk", enabled: false },
    });
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(brokerOptionsFromRegistry(step2.registry).map((o) => o.id)).not.toContain("prime_desk");
    expect(
      validateAccountBindingInput({
        broker: "prime_desk",
        mode: "live",
        accountType: "treasury_direct",
        accountId: "PD-9001",
        registry: step2.registry,
      }).ok,
    ).toBe(false);
  });

  it("5097-P02: persists registry updates via /broker/account-binding API and MCP tool and allows binding to newly registered entries", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;

    const patchRes = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registryPatch: {
            addAssetType: "commodities",
            addAccountType: "sep_ira",
            upsertBroker: {
              id: "global_fx",
              label: "Global FX & Commodities",
              enabled: true,
              modes: ["paper", "live"],
              assetTypes: ["commodities"],
            },
          },
        }),
      }),
      new URL("https://example.com/broker/account-binding"),
      "/broker/account-binding",
      "trader@example.com",
      { env },
    );
    expect(patchRes?.status).toBe(200);

    // Bind an account to the newly registered broker & accountType through the API
    const bindRes = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          broker: "global_fx",
          mode: "live",
          accountType: "sep_ira",
          scope: "tenant",
          accountId: "GFX-777",
        }),
      }),
      new URL("https://example.com/broker/account-binding"),
      "/broker/account-binding",
      "trader@example.com",
      { env },
    );
    expect(bindRes?.status).toBe(200);
    const bindJson = (await bindRes?.json()) as { ok: boolean; binding: { broker: string; accountType: string; accountId: string } };
    expect(bindJson.ok).toBe(true);
    expect(bindJson.binding).toMatchObject({
      broker: "global_fx",
      accountType: "sep_ira",
      accountId: "GFX-777",
    });

    // Also verify MCP command registry_get and registry_update
    const cmd = new BrokerAccountBindingCommand();
    const mcpUpdate = (await cmd.execute(
      {
        action: "registry_update",
        registryPatch: { addAccountType: " custodial_ira " },
      },
      { env, sessionId: "trader@example.com" } as never,
    )) as { ok: boolean; registry: { accountTypes: string[] } };
    expect(mcpUpdate.ok).toBe(true);
    expect(mcpUpdate.registry.accountTypes).toContain("custodial_ira");
  });

  it("5097-P03: AccountBindingSelector UX renders registry-driven options and manages registry entries interactively", async () => {
    const base = buildDefaultBrokerAssetAccountRegistry();
    const patched = applyBrokerRegistryPatch(base, {
      addAccountType: "solo_401k",
      upsertBroker: { id: "custom_venue", label: "Custom Venue", enabled: true, modes: ["paper", "live"] },
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;

    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        registry: patched.registry,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    const root = createRoot(mountedContainer);

    await act(async () => {
      root.render(
        <AccountBindingSelector
          broker="custom_venue"
          mode="paper"
          initialBindings={[]}
          initialRegistry={patched.registry}
        />,
      );
    });

    expect(mountedContainer.textContent).toContain("Custom Venue (custom_venue)");
    expect(mountedContainer.textContent).toContain("solo_401k");
    expect(mountedContainer.textContent).toContain("Manage Registry");

    // Open the registry manager panel
    const manageBtn = Array.from(mountedContainer.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Manage Registry"),
    );
    expect(manageBtn).toBeTruthy();
    await act(async () => {
      manageBtn?.click();
    });

    expect(mountedContainer.textContent).toContain("Broker, Asset-Type & Account-Type Registry");
    expect(mountedContainer.textContent).toContain("Custom Venue: Enabled");

    await act(async () => {
      root.unmount();
    });
  });
});
