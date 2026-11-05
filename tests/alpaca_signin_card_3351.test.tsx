/** @vitest-environment jsdom */
/**
 * Issue #3351 — the Alpaca sign-in card.
 *
 * What these tests defend:
 *   1. A signed-out user is asked for the pair; a deployment-served account is
 *      named as exactly that, not as "connected".
 *   2. A successful sign-in reports the trading type and the key id's last four,
 *      and the secret is gone from component state the moment the request ends.
 *   3. A refusal renders the outcome-coded business message, never an upstream
 *      body.
 *   4. Signing out goes through the disconnect route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AlpacaSignInCard } from "../src/client/AlpacaSignInCard";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const SIGNED_OUT = {
  side: "paper",
  configured: false,
  signedIn: false,
  source: "none",
  keyIdLast4: null,
  storedAt: null,
};

function mockRoutes(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const key = Object.keys(handlers).find((path) => url.includes(path));
      const res = key ? handlers[key](init) : { status: 404, body: { code: "not_found" } };
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.body,
      } as unknown as Response;
    }),
  );
  return calls;
}

function setInput(name: string, value: string) {
  const input = container.querySelector(`[data-alpaca-signin-field="${name}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit() {
  const form = container.querySelector("form") as HTMLFormElement;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("Alpaca sign-in card (#3351)", () => {
  it("asks for the pair when nothing is connected", async () => {
    mockRoutes({ "/broker/connect/alpaca": () => ({ status: 200, body: SIGNED_OUT }) });
    act(() => root.render(<AlpacaSignInCard />));
    await flush();

    expect(container.textContent).toContain("Not connected");
    expect(container.querySelector('[data-alpaca-signin-field="apiKey"]')).not.toBeNull();
    expect(container.querySelector('[data-alpaca-signin-field="secretKey"]')).not.toBeNull();
    expect(container.querySelector('[data-alpaca-signin-source="none"]')).not.toBeNull();
  });

  it("names a deployment-served account as the deployment's, not as a sign-in", async () => {
    mockRoutes({
      "/broker/connect/alpaca": () => ({
        status: 200,
        body: { ...SIGNED_OUT, configured: true, source: "deployment", keyIdLast4: "1234" },
      }),
    });
    act(() => root.render(<AlpacaSignInCard />));
    await flush();

    expect(container.textContent).toContain("Deployment keys");
    expect(container.querySelector('[data-alpaca-signin-source="deployment"]')).not.toBeNull();
    expect(container.textContent).toContain("Sign in with your own key pair");
  });

  it("signs in, reports the last four, and drops the secret", async () => {
    const calls = mockRoutes({
      "/broker/connect/alpaca": (init) =>
        init?.method === "POST"
          ? {
              status: 200,
              body: {
                side: "paper",
                configured: true,
                signedIn: true,
                source: "user",
                keyIdLast4: "7777",
                storedAt: "2026-11-05T00:00:00.000Z",
              },
            }
          : { status: 200, body: SIGNED_OUT },
    });

    act(() => root.render(<AlpacaSignInCard />));
    await flush();

    setInput("apiKey", "PK7777777777");
    setInput("secretKey", "shhh-secret");
    submit();
    await flush();

    const post = calls.find((call) => call.init?.method === "POST");
    expect(String(post?.init?.body)).toContain("PK7777777777");
    expect(container.textContent).toContain("••••7777");
    expect(container.textContent).not.toContain("shhh-secret");
    expect((container.querySelector('[data-alpaca-signin-field="secretKey"]') as HTMLInputElement | null)).toBeNull();
  });

  it("renders the coded business message when Alpaca refuses the pair", async () => {
    const code = "FAILURE_ALPACA_SIGNIN_REJECTED";
    const message =
      "Alpaca rejected that key pair for the selected trading type. Check that the key id and secret belong to the paper or live account shown, then try again.";
    mockRoutes({
      "/broker/connect/alpaca": (init) =>
        init?.method === "POST" ? { status: 401, body: { code, message } } : { status: 200, body: SIGNED_OUT },
    });

    act(() => root.render(<AlpacaSignInCard />));
    await flush();

    setInput("apiKey", "BAD");
    setInput("secretKey", "bad");
    submit();
    await flush();

    const error = container.querySelector("[data-alpaca-signin-error]");
    expect(error?.textContent).toContain(message);
    expect(error?.textContent).toContain(code);
    expect(error?.textContent).not.toContain("<");
    // The form is still there to correct the pair.
    expect(container.querySelector('[data-alpaca-signin-field="apiKey"]')).not.toBeNull();
  });

  it("signs out through the disconnect route", async () => {
    const calls = mockRoutes({
      "/broker/connect/alpaca": () => ({
        status: 200,
        body: {
          side: "paper",
          configured: true,
          signedIn: true,
          source: "user",
          keyIdLast4: "7777",
          storedAt: "2026-11-05T00:00:00.000Z",
        },
      }),
      "/broker/disconnect/alpaca": () => ({
        status: 200,
        body: { ...SIGNED_OUT, disconnected: true },
      }),
    });

    act(() => root.render(<AlpacaSignInCard />));
    await flush();

    const signOut = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("Sign out"),
    ) as HTMLButtonElement;
    act(() => signOut.click());
    await flush();

    expect(calls.some((call) => call.url.includes("/broker/disconnect/alpaca"))).toBe(true);
    expect(container.querySelector('[data-alpaca-signin-field="apiKey"]')).not.toBeNull();
  });
});
