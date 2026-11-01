/** @vitest-environment jsdom */
/**
 * Issue #1385 (Alpaca provider slice, epic #1116) — panel surface pin.
 *
 * The slice changes no panel code (the E4 panel renders the API
 * response field-for-field). What this pins: when the API serves
 * alpaca enabled with a health block — the state the #1385 lifecycle
 * path produces — the panel renders the alpaca row as Enabled with
 * its health status, with no panel change required. Harness mirrors
 * the #1317 panel test (stubbed global fetch + react-dom/client).
 *
 * This pin PASSES on pristine control (the panel is already
 * generic) and is disclosed as a precondition pin, not Red. Its
 * value is guarding the slice: a future panel edit that drops the
 * alpaca row fails here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import type {
  CapabilityRouteView,
  DataProviderView,
} from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 800)}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (root) {
    act(() => {
      root.unmount();
    });
  }
  container?.remove();
});

const ALPACA_ENABLED: DataProviderView = {
  id: "alpaca",
  adapterKind: "alpaca-market-data",
  lifecycleState: "enabled",
  enabled: true,
  precedence: 5,
  credentialRef: "env:ALPACA_API_KEY",
  config: { displayName: "Alpaca Markets" },
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  declaredCapabilities: ["quotes", "historicalBars", "fundamentals"],
  verification: {
    verifiedAt: "2026-10-24T09:30:00.000Z",
    summary: "Alpaca adapter status configured; conformance passed for quotes, historicalBars, fundamentals.",
    verifiedBy: "tester",
  },
  serving: true,
  health: {
    status: "healthy",
    totalCaptures: 3,
    capturedCount: 3,
    failedCount: 0,
    failureRate: 0,
    lastSuccessAt: "2026-10-24T10:00:00.000Z",
    lastFailureAt: null,
    consecutiveFailures: 0,
    totalRawBytes: 1024,
    last24hCaptures: 3,
    last24hFailures: 0,
    byCapability: {},
    fetchAttempts: 3,
    fetchFailures: 0,
    fetchFailureRate: 0,
    captureFailures: 0,
    lastFetchFailureAt: null,
    fetchConsecutiveFailures: 0,
    latestFetchFailureKind: null,
  } as never,
};

const ROUTES: CapabilityRouteView[] = [
  { capability: "quotes", primaryProviderId: "etrade", gapFillProviderId: "yahoo", minTier: "freemium", resolves: true, resolvedPrimaryId: "etrade" },
  { capability: "historicalBars", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium", resolves: true, resolvedPrimaryId: "yahoo" },
  { capability: "fundamentals", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium", resolves: true, resolvedPrimaryId: "yahoo" },
];

describe("panel: alpaca enabled + health renders with no panel change (#1385)", () => {
  it("the alpaca row shows Enabled with its health status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/data-providers")) {
          return Response.json({ providers: [ALPACA_ENABLED], routes: ROUTES }, { status: 200 });
        }
        throw new Error(`unstubbed fetch: ${url}`);
      })
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ToastProvider, null, React.createElement(DataProvidersPanel)));
    });
    await waitForText("Alpaca Markets");
    const item = container.querySelector('[data-provider-id="alpaca"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("Enabled");
    expect(item!.querySelector(".dpp-health-status")).not.toBeNull();
  });
});
