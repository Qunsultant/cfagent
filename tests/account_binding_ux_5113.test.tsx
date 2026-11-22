// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleAccountBindingRoutes } from "../src/agents/routes/accountBindings";
import { AccountBindingSelector } from "../src/client/AccountBindingSelector";
import { ActiveBindingBadge } from "../src/client/ActiveBindingBadge";
import {
  adoptAccountBinding,
  invalidateAccountBindings,
  switchAccountBinding,
  useActiveAccountBinding,
} from "../src/client/accountBindingStore";
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

describe("Issue #5113 (Sub-issue 4 of #5094) — Account binding API route & UX", () => {
  it("handles GET, PUT, DELETE /broker/account-binding with auth & validation", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;

    const unauth = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding"),
      new URL("https://example.com/broker/account-binding"),
      "/broker/account-binding",
      "",
      { env },
    );
    expect(unauth?.status).toBe(401);

    const putRes = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          broker: "ibkr",
          mode: "live",
          accountType: "forex",
          scope: "autopilot",
          accountId: "U555-FX",
        }),
      }),
      new URL("https://example.com/broker/account-binding"),
      "/broker/account-binding",
      "trader@example.com",
      { env },
    );
    expect(putRes?.status).toBe(200);
    expect(await putRes?.json()).toMatchObject({
      ok: true,
      binding: { broker: "ibkr", mode: "live", accountType: "forex", scope: "autopilot", accountId: "U555-FX" },
    });

    const getRes = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding?accountType=forex"),
      new URL("https://example.com/broker/account-binding?accountType=forex"),
      "/broker/account-binding",
      "trader@example.com",
      { env },
    );
    expect(getRes?.status).toBe(200);
    const getBody = (await getRes?.json()) as { bindings: Array<{ accountId: string }> };
    expect(getBody.bindings).toHaveLength(1);
    expect(getBody.bindings[0].accountId).toBe("U555-FX");

    const delRes = await handleAccountBindingRoutes(
      new Request(
        "https://example.com/broker/account-binding?broker=ibkr&mode=live&accountType=forex&scope=autopilot",
        { method: "DELETE" },
      ),
      new URL("https://example.com/broker/account-binding?broker=ibkr&mode=live&accountType=forex&scope=autopilot"),
      "/broker/account-binding",
      "trader@example.com",
      { env },
    );
    expect(delRes?.status).toBe(200);
    expect(await delRes?.json()).toEqual({ ok: true, removed: true });
  });

  it("renders active bindings and submits a new binding in AccountBindingSelector", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        binding: {
          broker: "alpaca",
          mode: "paper",
          accountType: "stock",
          scope: "tenant",
          accountId: "PA-888",
          updatedAt: new Date().toISOString(),
          updatedBy: "user",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    const root = createRoot(mountedContainer);

    await act(async () => {
      root.render(
        <AccountBindingSelector
          broker="alpaca"
          mode="paper"
          initialBindings={[
            {
              broker: "alpaca",
              mode: "paper",
              accountType: "stock",
              scope: "tenant",
              accountId: "PA-100",
              updatedAt: "2026-11-17T00:00:00.000Z",
              updatedBy: "user",
            },
          ]}
        />,
      );
    });

    expect(mountedContainer.textContent).toContain("PA-100");
    expect(mountedContainer.textContent).toContain("Bind Account");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("Issue #5099 (F2 of #5094) — active-binding store, badge, validated saves", () => {
  const bindingsFixture = [
    {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "tenant",
      accountId: "PA-100",
      updatedAt: "2026-11-17T00:00:00.000Z",
      updatedBy: "user",
    },
    {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "schedule",
      accountId: "PA-200",
      updatedAt: "2026-11-17T00:00:00.000Z",
      updatedBy: "user",
    },
  ];

  function stubBindingsFetch(bindings: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/broker/account-binding")) {
          return Response.json({ ok: true, bindings });
        }
        return Response.json({ ok: true, bindings: [] });
      }),
    );
  }

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function Probe({ broker, mode, accountType, scope }: { broker: string; mode: "paper" | "live"; accountType: "stock" | "options"; scope: "tenant" | "schedule" | "autopilot" }) {
    const { found, binding, resolvedFromScope, loaded } = useActiveAccountBinding({ broker, mode, accountType, scope });
    return (
      <div>
        {loaded ? "loaded" : "loading"}|{found ? "found" : "missing"}|{binding?.accountId ?? "none"}|{resolvedFromScope ?? "none"}
      </div>
    );
  }

  function mount(node: React.ReactNode) {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    const root = createRoot(mountedContainer);
    return { root, container: mountedContainer };
  }

  it("resolves the exact scope, falls back to the tenant default, and reports a missing slot", async () => {
    invalidateAccountBindings();
    stubBindingsFetch(bindingsFixture);

    const { root, container } = mount(
      <Probe broker="alpaca" mode="paper" accountType="stock" scope="schedule" />,
    );
    await act(async () => {
      root.render(<Probe broker="alpaca" mode="paper" accountType="stock" scope="schedule" />);
    });
    await flush();
    expect(container.textContent).toBe("loaded|found|PA-200|schedule");

    await act(async () => {
      root.render(<Probe broker="alpaca" mode="paper" accountType="stock" scope="autopilot" />);
    });
    await flush();
    expect(container.textContent).toBe("loaded|found|PA-100|tenant");

    await act(async () => {
      root.render(<Probe broker="alpaca" mode="paper" accountType="options" scope="tenant" />);
    });
    await flush();
    expect(container.textContent).toBe("loaded|missing|none|none");

    await act(async () => {
      root.unmount();
    });
  });

  it("re-renders subscribed surfaces when a binding is adopted", async () => {
    invalidateAccountBindings();
    stubBindingsFetch(bindingsFixture);

    const { root, container } = mount(
      <Probe broker="alpaca" mode="paper" accountType="stock" scope="tenant" />,
    );
    await act(async () => {
      root.render(<Probe broker="alpaca" mode="paper" accountType="stock" scope="tenant" />);
    });
    await flush();
    expect(container.textContent).toContain("PA-100");

    await act(async () => {
      adoptAccountBinding({
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        scope: "tenant",
        accountId: "PA-999",
        updatedAt: new Date().toISOString(),
        updatedBy: "user",
      });
    });
    await flush();
    expect(container.textContent).toContain("PA-999");

    await act(async () => {
      root.unmount();
    });
  });

  it("badge shows the masked account, the unbound state, and the override; Change dispatches open-settings-menu", async () => {
    invalidateAccountBindings();
    stubBindingsFetch(bindingsFixture);

    const { root, container } = mount(
      <ActiveBindingBadge broker="alpaca" mode="paper" accountType="stock" scope="tenant" />,
    );
    await act(async () => {
      root.render(
        <ActiveBindingBadge broker="alpaca" mode="paper" accountType="stock" scope="tenant" />,
      );
    });
    await flush();
    expect(container.textContent).toContain("Stock ••••-100");
    expect(container.textContent).toContain("Change");

    const dispatched: string[] = [];
    const listener = () => dispatched.push("open-settings-menu");
    window.addEventListener("open-settings-menu", listener);
    const changeButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Change"),
    );
    expect(changeButton).toBeDefined();
    await act(async () => {
      changeButton!.click();
    });
    expect(dispatched).toEqual(["open-settings-menu"]);
    window.removeEventListener("open-settings-menu", listener);

    await act(async () => {
      root.render(
        <ActiveBindingBadge
          broker="alpaca"
          mode="paper"
          accountType="stock"
          scope="tenant"
          override={{ accountId: "PA-777", accountType: "options" }}
        />,
      );
    });
    await flush();
    expect(container.textContent).toContain("Options ••••-777");

    await act(async () => {
      root.unmount();
    });

    // Unbound: no bindings at all.
    invalidateAccountBindings();
    stubBindingsFetch([]);
    const second = mount(
      <ActiveBindingBadge broker="alpaca" mode="paper" accountType="stock" scope="tenant" />,
    );
    await act(async () => {
      second.root.render(
        <ActiveBindingBadge broker="alpaca" mode="paper" accountType="stock" scope="tenant" />,
      );
    });
    await flush();
    expect(second.container.textContent).toContain("No account bound");
    await act(async () => {
      second.root.unmount();
    });
  });

  it("selector save includes availableAccounts when the accounts read serves the saved broker, and omits them on mismatch", async () => {
    const putBodies: Record<string, unknown>[] = [];
    const stubFor = (accountsBroker: string) =>
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/broker/accounts")) {
          return Response.json({
            broker: accountsBroker,
            environment: "TEST",
            result: [{ accountId: "PA-100", accountType: "stock", accountName: "Alpaca Paper" }],
          });
        }
        if (String(url).includes("/api/broker/account-binding") && init?.method === "PUT") {
          putBodies.push(JSON.parse(String(init.body)));
          return Response.json({
            ok: true,
            binding: {
              broker: "alpaca",
              mode: "paper",
              accountType: "stock",
              scope: "tenant",
              accountId: "PA-100",
              updatedAt: new Date().toISOString(),
              updatedBy: "user",
            },
          });
        }
        return Response.json({ ok: true, bindings: [], registry: undefined });
      });

    async function saveOnce(accountsBroker: string) {
      putBodies.length = 0;
      vi.stubGlobal("fetch", stubFor(accountsBroker));
      const { root, container } = mount(
        <AccountBindingSelector broker="alpaca" mode="paper" />,
      );
      await act(async () => {
        root.render(<AccountBindingSelector broker="alpaca" mode="paper" />);
      });
      await flush();
      const input = container.querySelector('input[placeholder="e.g. U1234567"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, "PA-100");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const saveButton = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Bind Account"),
      );
      expect(saveButton).toBeDefined();
      await act(async () => {
        saveButton!.click();
      });
      await flush();
      await flush();
      expect(container.textContent).toContain("Bound alpaca");
      const body = putBodies[0];
      await act(async () => {
        root.unmount();
      });
      return body;
    }

    const matched = await saveOnce("alpaca");
    expect(matched).toMatchObject({ broker: "alpaca", accountId: "PA-100" });
    expect(matched?.availableAccounts).toEqual([
      { accountId: "PA-100", accountType: "stock", accountName: "Alpaca Paper", broker: "alpaca" },
    ]);

    const mismatched = await saveOnce("etrade");
    expect(mismatched).toMatchObject({ broker: "alpaca", accountId: "PA-100" });
    expect("availableAccounts" in (mismatched ?? {})).toBe(false);
  });

  it("switchAccountBinding adopts on success and reverts on a server refusal", async () => {
    // Success path.
    invalidateAccountBindings();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/broker/account-binding") && init?.method === "PUT") {
          return Response.json({
            ok: true,
            binding: {
              broker: "alpaca",
              mode: "paper",
              accountType: "stock",
              scope: "tenant",
              accountId: "PA-300",
              updatedAt: new Date().toISOString(),
              updatedBy: "user",
            },
          });
        }
        return Response.json({ ok: true, bindings: [] });
      }),
    );
    const okResult = await switchAccountBinding({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-300",
    });
    expect(okResult.ok).toBe(true);
    const { root, container } = mount(
      <Probe broker="alpaca" mode="paper" accountType="stock" scope="tenant" />,
    );
    await act(async () => {
      root.render(<Probe broker="alpaca" mode="paper" accountType="stock" scope="tenant" />);
    });
    await flush();
    expect(container.textContent).toContain("PA-300");

    // Refusal path: the previous binding survives.
    invalidateAccountBindings();
    stubBindingsFetch(bindingsFixture);
    await act(async () => {
      root.render(<Probe broker="alpaca" mode="paper" accountType="stock" scope="tenant" />);
    });
    await flush();
    expect(container.textContent).toContain("PA-100");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/broker/account-binding") && init?.method === "PUT") {
          return Response.json(
            { ok: false, code: "FAILURE_ACCOUNT_UNKNOWN", error: "[FAILURE_ACCOUNT_UNKNOWN] Unknown account." },
            { status: 400 },
          );
        }
        return Response.json({ ok: true, bindings: bindingsFixture });
      }),
    );
    const refused = await switchAccountBinding(
      { broker: "alpaca", mode: "paper", accountType: "stock", accountId: "PA-999" },
      [{ accountId: "PA-100", broker: "alpaca" }],
    );
    expect(refused.ok).toBe(false);
    await flush();
    expect(container.textContent).toContain("PA-100");
    expect(container.textContent).not.toContain("PA-999");

    await act(async () => {
      root.unmount();
    });
  });
});
