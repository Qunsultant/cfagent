/** @vitest-environment jsdom */
/**
 * Issue #4652 — Gap 3 of #4634: flipping TEST→PROD armed live placement with one
 * click and no confirmation. The mode is global (`etrade:environment`), so the
 * flip applies to every broker, not only the selected one.
 *
 * Pinned here:
 *  - the settings menu's TWO env controls (the mini toggle and the Policy Mode
 *    pill group) both ask first when the target is PROD;
 *  - the dialog names the selected broker and says orders will place with real
 *    money (the copy is shared with #4649's Public path);
 *  - confirming posts `/environment/switch` EXACTLY ONCE (#3784's duplicate-post
 *    incident stays fixed);
 *  - cancelling posts nothing and leaves the mode where it was;
 *  - switching back to paper posts immediately — de-arming needs no ceremony.
 *
 * No network: every request goes through a stubbed fetch.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BrokerDynamicMenu } from "../src/client/BrokerDynamicMenu";
import { setBrokerEnvironmentForTest } from "../src/client/brokerEnvironment";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("#4652 — arming live trading asks first", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: { url: string; method: string; body?: string }[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    window.localStorage.setItem("cfagent_tenant_broker", "alpaca");
    window.localStorage.setItem("cfagent_tenant_data_provider", "alpaca");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
        const target = String(url);
        const method = init?.method ?? "GET";
        calls.push({ url: target, method, body: typeof init?.body === "string" ? init.body : undefined });
        if (method === "POST") {
          return { ok: true, status: 200, json: async () => JSON.parse(String(init?.body)), text: async () => "" } as unknown as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    // Issue #5879: the menu reads the module environment value, so
    // reset it — a confirmed switch in one test would otherwise leak
    // into the next render.
    setBrokerEnvironmentForTest("TEST");
  });

  function buttons(scope: ParentNode = container): HTMLButtonElement[] {
    return Array.from(scope.querySelectorAll("button")) as HTMLButtonElement[];
  }

  function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
    return buttons(scope).find((b) => (b.textContent ?? "").includes(text));
  }

  function envToggleButton(): HTMLButtonElement | undefined {
    return buttons().find((b) => (b.getAttribute("title") ?? "").startsWith("Current mode:"));
  }

  async function click(element: HTMLButtonElement | undefined) {
    expect(element, "button not found").toBeTruthy();
    await act(async () => {
      element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  function switchPosts() {
    return calls.filter((c) => c.url.includes("/api/environment/switch") && c.method === "POST");
  }

  async function renderMenu(env: "TEST" | "PROD") {
    // Issue #5879: the environment is set on the module value, not
    // passed as a prop — the menu reads the one persisted selection.
    setBrokerEnvironmentForTest(env);
    await act(async () => {
      root.render(
        <BrokerDynamicMenu
          initialOpen
          onToggleAccountMode={() => undefined}
        />,
      );
      await Promise.resolve();
    });
  }

  it("asks before the Policy Mode pill arms live, and posts exactly once on confirm", async () => {
    await renderMenu("TEST");

    await click(buttonByText("Live Real"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog, "the confirmation dialog").not.toBeNull();
    expect(dialog!.textContent).toContain("Switch to live trading on Alpaca?");
    expect(dialog!.textContent).toMatch(/real money/i);
    expect(switchPosts()).toHaveLength(0);

    await click(buttonByText("Switch to live trading", dialog!));
    expect(switchPosts()).toHaveLength(1);
    expect(switchPosts()[0].body).toContain('"PROD"');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("asks before the environment toggle arms live, and cancelling posts nothing", async () => {
    await renderMenu("TEST");

    await click(envToggleButton());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Switch to live trading on Alpaca?");

    await click(buttonByText("Stay in paper", dialog!));
    expect(switchPosts()).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("switches back to paper immediately — no dialog, one post", async () => {
    await renderMenu("PROD");

    await click(envToggleButton());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(switchPosts()).toHaveLength(1);
    expect(switchPosts()[0].body).toContain('"TEST"');
  });
});
