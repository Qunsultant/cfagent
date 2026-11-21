/**
 * @vitest-environment jsdom
 *
 * Issue #3784 (parent incident #3781) — one user switch action must
 * POST /environment/switch exactly once. Before the fix the menu
 * posted 2–3 times per action: `onSwitchEnv` called BOTH the
 * `handleSwitchEnvironment` prop AND `switchBrokerEnvironment`
 * directly; the Policy Mode pill additionally called
 * `onToggleAccountMode` (Chat's toggle also POSTs); the banner
 * additionally called `handleSwitchAndConnect` (which POSTs through
 * `handleSwitchEnvironment`). The three incident /environment/switch
 * jobs (342ba7f2 / cdf703f4 / 316bfe5a) came from one pill click.
 *
 * The props below mimic the real parent wirings: Chat passes
 * `handleSwitchEnvironment={(t) => void switchBrokerEnvironment(t)}`
 * and `handleToggleAccountMode={() => void switchBrokerEnvironment(next)}`;
 * TradeHub passes its own `handleSwitchEnvironment` (POST +
 * status refetch) and `handleSwitchAndConnect` (switch + OAuth start).
 * The POST count is what is pinned, so the test doubles post once
 * through the real `switchBrokerEnvironment`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrokerDynamicMenu } from "../src/client/BrokerDynamicMenu";
import { switchBrokerEnvironment, setBrokerEnvironmentForTest } from "../src/client/brokerEnvironment";
import { setTenantProvidersStateForTest, resetTenantProvidersStateForTest } from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("one switch action posts /environment/switch exactly once (#3784)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let switchPosts: Array<{ environment: string }> = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    switchPosts = [];
    // Issue #5879: the menu reads the module environment value, so
    // reset it — a confirmed switch in one test flips the module, and
    // without a reset the next render would start live instead of paper.
    setBrokerEnvironmentForTest("TEST");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/environment/switch" && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { environment: string };
          switchPosts.push({ environment: body.environment });
          return new Response(JSON.stringify({ success: true, environment: body.environment }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
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

  async function renderMenu(props: Partial<React.ComponentProps<typeof BrokerDynamicMenu>> = {}) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <BrokerDynamicMenu
          initialOpen={true}
          userLogin="OpenAIMP"
          userName="OpenAIMP User"
          {...props}
        />,
      );
    });
  }

  async function click(el: Element) {
    await act(async () => {
      (el as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes(text),
    );
    if (!button) throw new Error(`button containing "${text}" not found`);
    return button as HTMLButtonElement;
  }

  /**
   * Issue #4652: arming live trading now opens the confirmation dialog (a
   * portal on document.body) before any POST, so the single-post property is
   * pinned by walking through it. The property itself is unchanged.
   */
  async function confirmLiveSwitch() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("the live-switch confirmation dialog did not open");
    const confirm = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Switch to live trading"),
    );
    if (!confirm) throw new Error("the dialog's confirm button was not found");
    await click(confirm);
  }

  it("menu toggle with the Chat prop posts once (was: prop + direct = 2)", async () => {
    await renderMenu({
      handleSwitchEnvironment: (target) => void switchBrokerEnvironment(target),
    });
    await click(buttonByText("Paper"));
    // Issue #4652: the click asks first; nothing is posted yet.
    expect(switchPosts).toEqual([]);
    await confirmLiveSwitch();
    expect(switchPosts).toEqual([{ environment: "PROD" }]);
  });

  it("menu toggle with no prop posts once via the direct import", async () => {
    await renderMenu();
    await click(buttonByText("Paper"));
    expect(switchPosts).toEqual([]);
    await confirmLiveSwitch();
    expect(switchPosts).toEqual([{ environment: "PROD" }]);
  });

  it("Policy Mode pill posts once (was: switch + toggle = 3)", async () => {
    await renderMenu({
      handleSwitchEnvironment: (target) => void switchBrokerEnvironment(target),
      // Chat's handleToggleAccountMode: paper -> PROD, posts directly.
      onToggleAccountMode: () => void switchBrokerEnvironment("PROD"),
    });
    const pillGroup = container.querySelector('[aria-label="Policy account mode"]');
    expect(pillGroup).not.toBeNull();
    const livePill = [...pillGroup!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Live Real"),
    );
    expect(livePill).toBeDefined();
    await click(livePill!);
    expect(switchPosts).toEqual([]);
    await confirmLiveSwitch();
    expect(switchPosts).toEqual([{ environment: "PROD" }]);
  });

  it("banner Switch to TEST & Connect posts once (was: switch + switch-and-connect = 3)", async () => {
    await renderMenu({
      oauthMsg: "Please switch environment to TEST to connect.",
      handleSwitchEnvironment: (target) => void switchBrokerEnvironment(target),
      // TradeHub's handleSwitchAndConnect: switch, then OAuth start.
      handleSwitchAndConnect: async (target) => {
        await switchBrokerEnvironment(target);
      },
    });
    await click(buttonByText("Switch to TEST"));
    expect(switchPosts).toEqual([{ environment: "TEST" }]);
  });
});
