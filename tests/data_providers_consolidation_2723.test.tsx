/**
 * @vitest-environment jsdom
 *
 * Issue #2723: Consolidate provider connectivity into Platform Admin Data Providers
 * in a tabular presentation with standardized action buttons and streamline ScreenersHub.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const dppSrc = readFileSync(
  join(here, "..", "src", "client", "DataProvidersPanel.tsx"),
  "utf8",
);
const screenersSrc = readFileSync(
  join(here, "..", "src", "client", "ScreenersHub.tsx"),
  "utf8",
);

describe("Data Providers consolidation & tabular presentation (#2723)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("source defines tabular structure and ScreenersHub callout link", () => {
    expect(dppSrc).toContain("dpp-table");
    expect(dppSrc).toContain("<Table");
    expect(dppSrc).toContain('header: "Provider"');
    expect(dppSrc).toContain('header: "Connectivity & Session"');
    expect(dppSrc).toContain('header: "Actions"');

    // ScreenersHub no longer mounts ProviderConnectivityDashboard, but keeps callout link
    expect(screenersSrc).not.toContain("<ProviderConnectivityDashboard />");
    expect(screenersSrc).toContain('id="provider-dashboard"');
    expect(screenersSrc).toContain('href="/?tab=platform-admin&view=data-providers"');
  });

  it("renders tabular table with consolidated E*TRADE session scopes and standard buttons", async () => {
    const mockProviders = [
      {
        id: "etrade",
        adapterKind: "etrade",
        lifecycleState: "enabled",
        enabled: true,
        precedence: 1,
        credentialRef: "env:ETRADE_KEY",
        declaredCapabilities: ["quotes", "optionsChains"],
        serving: true,
        health: {
          status: "healthy",
          totalCaptures: 100,
          capturedCount: 95,
          failedCount: 5,
          failureRate: 0.05,
          capturesLast24h: 20,
          failuresLast24h: 1,
          totalRawBytes: 50000,
          byCapability: {},
        },
      },
      {
        id: "alpaca",
        adapterKind: "alpaca",
        lifecycleState: "registered",
        enabled: false,
        precedence: 2,
        credentialRef: null,
        declaredCapabilities: ["quotes"],
        serving: false,
        health: null,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/data-providers")) {
          return Response.json({ providers: mockProviders, routes: [] }, { status: 200 });
        }
        if (url.includes("/api/etrade/oauth/status")) {
          return Response.json(
            {
              authenticated: true,
              tokenScopes: {
                loginScoped: true,
                unscoped: true,
                internalId: false,
                aliasLogin: false,
              },
            },
            { status: 200 },
          );
        }
        throw new Error(`unstubbed: ${url}`);
      }),
    );

    await act(async () => {
      root = createRoot(container);
      root.render(
        <ToastProvider>
          <DataProvidersPanel />
        </ToastProvider>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Verifies table element exists
    const table = container.querySelector("table.dpp-table");
    expect(table).not.toBeNull();

    // Verifies headers
    const ths = Array.from(table!.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(ths).toEqual([
      "Provider",
      "Lifecycle & State",
      "Health & Telemetry",
      "Capabilities & Routes",
      "Connectivity & Session",
      "Actions",
    ]);

    // Verifies E*TRADE row has consolidated token scope presence
    const etradeRow = container.querySelector('[data-provider-id="etrade"]');
    expect(etradeRow).not.toBeNull();
    expect(etradeRow!.textContent).toContain("Panel (signed-in session): connected");
    expect(etradeRow!.textContent).toContain("login-scoped: present");
    expect(etradeRow!.textContent).toContain("internal-id: absent");

    // Verifies consistent standard buttons on etrade row
    const etradeButtons = Array.from(etradeRow!.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(etradeButtons).toEqual(["Configure", "Verify", "Disable", "Deprovision"]);

    // Verifies consistent standard buttons on alpaca row
    const alpacaRow = container.querySelector('[data-provider-id="alpaca"]');
    expect(alpacaRow).not.toBeNull();
    const alpacaButtons = Array.from(alpacaRow!.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(alpacaButtons).toEqual(["Configure", "Verify", "Enable", "Deprovision"]);
  });
});
