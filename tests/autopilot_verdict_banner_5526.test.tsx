/** @vitest-environment jsdom */

/**
 * Issue #5526 — the Autopilot control centre renders the repeated-binding-rule
 * verdict banner.
 *
 * #5061 gave `GET /autopilot` a `verdictTrend` aggregate (evaluations, blocked,
 * repeatedBindingRules, escalated, notice). The control centre already fetched
 * that payload and rendered `recentVerdicts`, but nothing rendered the trend —
 * so the operator saw the raw list, not the pattern. The banner quotes the
 * notice verbatim (it is the source of truth) and links to the limits editor
 * where the human actually changes the envelope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { AutopilotControlCenter } from "../src/client/components/AutopilotControlCenter";
import { ToastProvider } from "../src/client/components/ui";

const trend = {
  enabled: true,
  evaluations: 4,
  blocked: 3,
  passed: 1,
  repeatedBindingRules: [{ rule: "max_daily_notional", count: 2 }],
  escalated: true,
  notice:
    "Autopilot policy checks blocked 3 of the last 4 time(s); repeated binding rule(s): max_daily_notional ×2. The envelope is changed by a human — this is evidence, not an automatic adjustment.",
};

function mockFetch(payload: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("/api/autopilot")) {
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

const flush = async (times = 8) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

let mounted: Root | null = null;

async function render() {
  // The active sub-tab is URL-owned; open Policy decisions before mount.
  window.history.replaceState({}, "", "/?view=policy-decisions");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <AutopilotControlCenter />
      </ToastProvider>,
    );
  });
  await flush();
  mounted = root;
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.unmount());
    mounted = null;
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Issue #5526 — autopilot verdict trend banner", () => {
  it("renders the notice and the repeated rule when the trend escalates", async () => {
    mockFetch({
      running: true,
      killSwitch: false,
      limits: {},
      recentVerdicts: [],
      verdictTrend: trend,
    });

    const container = await render();
    const text = container.textContent ?? "";

    expect(text).toContain("repeated binding rule");
    expect(text).toContain("max_daily_notional");
    expect(text).toContain("changed by a human");
    expect(text.toLowerCase()).toContain("limits");
  });

  it("renders nothing when the trend does not escalate", async () => {
    mockFetch({
      running: true,
      killSwitch: false,
      limits: {},
      recentVerdicts: [],
      verdictTrend: { ...trend, escalated: false, notice: null, repeatedBindingRules: [] },
    });

    const container = await render();
    expect(container.textContent ?? "").not.toContain("repeated binding rule");
  });

  it("tolerates an older payload with no trend", async () => {
    mockFetch({ running: true, killSwitch: false, limits: {}, recentVerdicts: [] });
    const container = await render();
    expect(container.textContent ?? "").not.toContain("repeated binding rule");
  });
});
