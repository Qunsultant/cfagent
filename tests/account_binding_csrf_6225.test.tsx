// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AccountBindingSelector } from "../src/client/AccountBindingSelector";
import { buildDefaultBrokerAssetAccountRegistry } from "../src/trading";

// Issue #6225 — the selector's PUTs omit the CSRF token, so the #3113
// gate 403s every cookie-authenticated binding save with `csrf_invalid`
// before any route work happens, and the UI shows only the generic
// text because the 403 body carries {error, code} but no `message`.
const UUID_6225 = "913e836a-1d2d-4956-8f28-2ac262a272bd";
const CSRF_403_BODY = {
  error: "CSRF token missing or invalid for this cookie-authenticated mutation.",
  code: "csrf_invalid",
};

let mountedContainer: HTMLDivElement | null = null;

afterEach(() => {
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
  document.cookie = "csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(node: React.ReactNode) {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  const root = createRoot(mountedContainer);
  return { root, container: mountedContainer };
}

interface PutCapture {
  url: string;
  init: RequestInit;
}

function stubSelectorFetch(opts: { putStatus?: number; putBody?: unknown } = {}) {
  const puts: PutCapture[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/broker/accounts")) {
        return Response.json({
          broker: "alpaca",
          environment: "TEST",
          result: [
            { accountId: UUID_6225, accountType: "stock", accountName: "Alpaca Trading Account" },
          ],
        });
      }
      if (String(url).includes("/api/broker/account-binding") && init?.method === "PUT") {
        puts.push({ url: String(url), init: init ?? {} });
        if (opts.putStatus && opts.putStatus >= 400) {
          return Response.json(opts.putBody ?? CSRF_403_BODY, { status: opts.putStatus });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.registryPatch) {
          return Response.json({
            ok: true,
            registry: buildDefaultBrokerAssetAccountRegistry(),
          });
        }
        return Response.json({
          ok: true,
          binding: {
            broker: body.broker,
            mode: body.mode,
            accountType: body.accountType,
            scope: body.scope,
            accountId: body.accountId,
            updatedAt: new Date().toISOString(),
            updatedBy: "user",
          },
        });
      }
      return Response.json({ ok: true, bindings: [], registry: undefined });
    }),
  );
  return puts;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickBindAccount(container: HTMLDivElement) {
  const input = container.querySelector('input[placeholder="e.g. U1234567"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    setInputValue(input, UUID_6225);
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
}

function putHeaders(init: RequestInit): Record<string, string> {
  const headers = init.headers;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return (headers as Record<string, string> | undefined) ?? {};
}

describe("Issue #6225 — selector PUTs must carry the CSRF token", () => {
  it("6225-C01 handleSave PUT carries the X-CSRF-Token header from the csrf_token cookie", async () => {
    document.cookie = "csrf_token=csrf-6225-test";
    const puts = stubSelectorFetch();
    const { root, container } = mount(<AccountBindingSelector broker="alpaca" mode="paper" />);
    await act(async () => {
      root.render(<AccountBindingSelector broker="alpaca" mode="paper" />);
    });
    await flush();

    await clickBindAccount(container);

    expect(container.textContent).toContain(`Bound alpaca`);
    expect(puts).toHaveLength(1);
    expect(putHeaders(puts[0].init)).toMatchObject({ "X-CSRF-Token": "csrf-6225-test" });

    await act(async () => {
      root.unmount();
    });
  });

  it("6225-C02 applyRegistryPatch PUT carries the X-CSRF-Token header", async () => {
    document.cookie = "csrf_token=csrf-6225-test";
    const puts = stubSelectorFetch();
    const { root, container } = mount(<AccountBindingSelector broker="alpaca" mode="paper" />);
    await act(async () => {
      root.render(<AccountBindingSelector broker="alpaca" mode="paper" />);
    });
    await flush();

    const manageButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Manage Registry"),
    );
    expect(manageButton).toBeDefined();
    await act(async () => {
      manageButton!.click();
    });
    await flush();
    const brokerInput = container.querySelector(
      'input[placeholder="e.g. prime_fx"]',
    ) as HTMLInputElement;
    expect(brokerInput).not.toBeNull();
    await act(async () => {
      setInputValue(brokerInput, "prime_fx");
    });
    const saveBrokerButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save Broker"),
    );
    expect(saveBrokerButton).toBeDefined();
    await act(async () => {
      saveBrokerButton!.click();
    });
    await flush();
    await flush();

    expect(puts).toHaveLength(1);
    expect(putHeaders(puts[0].init)).toMatchObject({ "X-CSRF-Token": "csrf-6225-test" });

    await act(async () => {
      root.unmount();
    });
  });

  it("6225-C03 a 403 csrf_invalid failure surfaces the coded reason on save, not only the generic text", async () => {
    document.cookie = "csrf_token=csrf-6225-test";
    stubSelectorFetch({ putStatus: 403, putBody: CSRF_403_BODY });
    const { root, container } = mount(<AccountBindingSelector broker="alpaca" mode="paper" />);
    await act(async () => {
      root.render(<AccountBindingSelector broker="alpaca" mode="paper" />);
    });
    await flush();

    await clickBindAccount(container);

    expect(container.textContent).toContain("csrf_invalid");
    expect(container.textContent).not.toContain("Failed to save account binding.");

    await act(async () => {
      root.unmount();
    });
  });

  it("6225-C04 a 403 csrf_invalid failure surfaces the coded reason on a registry patch", async () => {
    document.cookie = "csrf_token=csrf-6225-test";
    stubSelectorFetch({ putStatus: 403, putBody: CSRF_403_BODY });
    const { root, container } = mount(<AccountBindingSelector broker="alpaca" mode="paper" />);
    await act(async () => {
      root.render(<AccountBindingSelector broker="alpaca" mode="paper" />);
    });
    await flush();

    const manageButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Manage Registry"),
    );
    expect(manageButton).toBeDefined();
    await act(async () => {
      manageButton!.click();
    });
    await flush();
    const brokerInput = container.querySelector(
      'input[placeholder="e.g. prime_fx"]',
    ) as HTMLInputElement;
    expect(brokerInput).not.toBeNull();
    await act(async () => {
      setInputValue(brokerInput, "prime_fx");
    });
    const saveBrokerButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save Broker"),
    );
    expect(saveBrokerButton).toBeDefined();
    await act(async () => {
      saveBrokerButton!.click();
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("csrf_invalid");
    expect(container.textContent).not.toContain("Failed to update registry.");

    await act(async () => {
      root.unmount();
    });
  });

  it("6225-C05 without a csrf_token cookie the PUT still fires without inventing a header", async () => {
    // withCsrfInit is a no-op when no token exists; the server gate then
    // rejects fail-closed. The client must not invent or omit the call.
    const puts = stubSelectorFetch();
    const { root, container } = mount(<AccountBindingSelector broker="alpaca" mode="paper" />);
    await act(async () => {
      root.render(<AccountBindingSelector broker="alpaca" mode="paper" />);
    });
    await flush();

    await clickBindAccount(container);

    expect(puts).toHaveLength(1);
    expect(putHeaders(puts[0].init)).not.toHaveProperty("X-CSRF-Token");

    await act(async () => {
      root.unmount();
    });
  });
});
