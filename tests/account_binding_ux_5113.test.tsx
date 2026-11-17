// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleAccountBindingRoutes } from "../src/agents/routes/accountBindings";
import { AccountBindingSelector } from "../src/client/AccountBindingSelector";
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
