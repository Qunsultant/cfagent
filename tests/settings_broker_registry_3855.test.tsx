/**
 * @vitest-environment jsdom
 *
 * Issue #3855: the settings broker list is registry-driven.
 * The menu renders exactly the catalog-derived list — no broker is
 * hard-coded in the settings UI. Adding a broker is a catalog entry
 * (+ its presentation); the settings page picks it up with no
 * settings-UI edit. Removing one removes it the same way.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brokerOptions } from "../src/client/brokerOptions";
import { BROKER_CATALOG, ROUTED_BROKER_IDS } from "../src/trading/brokerCatalog";
import { brokerPresentation } from "../src/trading/brokerPresentation";
import { BrokerDynamicMenu } from "../src/client/BrokerDynamicMenu";
import {
  setTenantProvidersStateForTest,
  resetTenantProvidersStateForTest,
} from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = join(__dirname, "..");

/** A third broker, as a catalog double: kind api_key_pair, its own label. */
const THREE_BROKER_CATALOG = {
  ...BROKER_CATALOG,
  ibkr: {
    id: "ibkr",
    label: "Interactive Brokers",
    credentialKind: "api_key_pair",
  },
} as const;

/** The presentation double for the three-broker catalog. */
function presentDouble(id: string): { icon: string } {
  if (id === "ibkr") return { icon: "🏦" };
  return brokerPresentation(id);
}

/** The catalog with one broker removed: the unregister case. */
const ONE_BROKER_CATALOG = {
  etrade: BROKER_CATALOG.etrade,
} as const;

describe("settings broker list is registry-driven (#3855)", () => {
  it("derives the production list from the catalog — ids, labels, kinds, icons", () => {
    const options = brokerOptions();
    expect(options.map((o) => o.id)).toEqual([...ROUTED_BROKER_IDS]);
    for (const opt of options) {
      expect(opt.label).toBe(BROKER_CATALOG[opt.id as keyof typeof BROKER_CATALOG].label);
      expect(opt.credentialKind).toBe(
        BROKER_CATALOG[opt.id as keyof typeof BROKER_CATALOG].credentialKind,
      );
      expect(opt.icon).toBe(brokerPresentation(opt.id).icon);
    }
    expect(options.find((o) => o.id === "etrade")?.icon).toBe("⚡");
    expect(options.find((o) => o.id === "alpaca")?.icon).toBe("🦙");
  });

  it("a third broker registered in the catalog appears with no settings-UI edit", () => {
    const options = brokerOptions(THREE_BROKER_CATALOG, presentDouble);
    expect(options.map((o) => o.id)).toEqual(["etrade", "alpaca", "ibkr"]);
    const third = options.find((o) => o.id === "ibkr");
    expect(third?.label).toBe("Interactive Brokers");
    expect(third?.credentialKind).toBe("api_key_pair");
    expect(third?.icon).toBe("🏦");
  });

  it("unregistering a broker removes it from the list", () => {
    const options = brokerOptions(ONE_BROKER_CATALOG, presentDouble);
    expect(options.map((o) => o.id)).toEqual(["etrade"]);
  });

  it("the derivation module hard-codes no broker id", () => {
    const src = readFileSync(join(HERE, "src/client/brokerOptions.ts"), "utf8");
    expect(src).not.toMatch(/etrade/i);
    expect(src).not.toMatch(/alpaca/i);
    expect(src).not.toMatch(/E\*TRADE/);
  });

  describe("menu renders the derived list", () => {
    let container: HTMLDivElement;
    let root: Root | null = null;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      localStorage.clear();
    });

    afterEach(() => {
      act(() => {
        root?.unmount();
      });
      root = null;
      if (container.parentElement) {
        container.parentElement.removeChild(container);
      }
      resetTenantProvidersStateForTest();
      vi.unstubAllGlobals();
    });

    it("renders one pill per catalog broker", async () => {
      setTenantProvidersStateForTest({ brokerId: "alpaca" });
      root = createRoot(container);
      await act(async () => {
        root.render(
          <BrokerDynamicMenu initialOpen={true} userLogin="OpenAIMP" userName="OpenAIMP User" />,
        );
      });
      const group = container.querySelector('[aria-label="Broker choice"]');
      expect(group).not.toBeNull();
      const pills = group!.querySelectorAll('button[role="radio"]');
      expect(pills.length).toBe(ROUTED_BROKER_IDS.length);
      const labels = Array.from(pills).map((p) => p.textContent);
      expect(labels.some((t) => t?.includes("E*TRADE"))).toBe(true);
      expect(labels.some((t) => t?.includes("Alpaca"))).toBe(true);
    });
  });
});
