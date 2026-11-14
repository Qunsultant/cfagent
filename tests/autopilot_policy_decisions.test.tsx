/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { AutopilotControlCenter } from "../src/client/components/AutopilotControlCenter";
import { ToastProvider } from "../src/client/components/ui/Toast";

const verdictsPayload = {
  running: false,
  killSwitch: false,
  killSwitchReason: null,
  ordersToday: 0,
  recentVerdicts: [
    {
      id: "v-1",
      symbol: "tsla",
      action: "buy",
      quantity: 40,
      notional: 9600,
      mode: "live",
      dry_run: 0,
      passed: 0,
      execution_allowed: 0,
      requires_approval: 0,
      binding_rule: "maxPositionPct",
      detail: "Position would exceed 10% of NAV",
      signature: "sig_ed25519_x",
      created_at: "2026-10-21T13:45:00.000Z",
    },
    {
      id: "v-2",
      symbol: "AAPL",
      action: "buy",
      quantity: 10,
      notional: 2305,
      mode: "live",
      dry_run: 1,
      passed: 1,
      execution_allowed: 1,
      requires_approval: 0,
      binding_rule: null,
      detail: "Within all limits",
      signature: "sig_ed25519_y",
      created_at: "2026-10-21T13:40:00.000Z",
    },
  ],
};

function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(
        typeof input === "string" ? input : (input as { url: string }).url,
        "http://localhost"
      );
      if (url.pathname === "/api/autopilot") {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`offline in test: ${url.pathname}`);
    })
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCenter() {
  // #4409: the verdicts table lives on the Policy decisions sub-tab —
  // the default view is Performance, so this file mounts its own tab.
  window.history.pushState(null, "", "/?tab=autopilot&view=policy-decisions");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <AutopilotControlCenter />
      </ToastProvider>,
    );
  });
  // Flush the mount effects' fetch promises.
  await act(async () => {});
  await act(async () => {});
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("AutopilotControlCenter policy decisions audit (issue #651)", () => {
  it("renders recorded verdicts: blocked with binding rule, allowed with dry-run label", async () => {
    stubFetch(verdictsPayload);
    await renderCenter();
    const text = container!.textContent ?? "";
    expect(text).toContain("Policy decisions");
    expect(text).toContain("TSLA");
    expect(text).toContain("Blocked");
    expect(text).toContain("maxPositionPct");
    expect(text).toContain("Position would exceed 10% of NAV");
    expect(text).toContain("Allowed");
    expect(text).toContain("$9,600");
    expect(text).toContain("dry run");
  });

  it("shows the empty state when no verdicts are recorded", async () => {
    stubFetch({ ...verdictsPayload, recentVerdicts: [] });
    await renderCenter();
    expect(container!.textContent ?? "").toContain("No policy decisions recorded");
  });
});
