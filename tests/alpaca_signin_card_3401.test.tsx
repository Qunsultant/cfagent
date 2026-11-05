/** @vitest-environment jsdom */
/**
 * Issue #3401 — Alpaca sign-in card CSRF and environment synchronization.
 *
 * What these tests defend:
 *   1. Requests to /api/broker/connect/alpaca and /api/broker/disconnect/alpaca
 *      send X-CSRF-Token headers from csrfHeaders().
 *   2. Active environment prop synchronizes the card to Live trading or Paper trading.
 *   3. Submitting the sign-in form passes the active environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AlpacaSignInCard } from "../src/client/AlpacaSignInCard";
import * as apiFetch from "../src/client/apiFetch";

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
  vi.spyOn(apiFetch, "csrfHeaders").mockReturnValue({ "X-CSRF-Token": "test-csrf-token-1234" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const PAPER_STATUS = {
  side: "paper",
  configured: true,
  signedIn: false,
  source: "deployment",
  keyIdLast4: "1111",
  storedAt: null,
};

const LIVE_STATUS = {
  side: "live",
  configured: true,
  signedIn: false,
  source: "deployment",
  keyIdLast4: "9999",
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

describe("Alpaca sign-in card CSRF and environment synchronization (#3401)", () => {
  it("sends CSRF header on POST /broker/connect/alpaca", async () => {
    const calls = mockRoutes({
      "/broker/connect/alpaca": (init) =>
        init?.method === "POST"
          ? {
              status: 200,
              body: {
                side: "live",
                configured: true,
                signedIn: true,
                source: "user",
                keyIdLast4: "8888",
                storedAt: "2026-11-05T00:00:00.000Z",
              },
            }
          : { status: 200, body: LIVE_STATUS },
    });

    act(() => root.render(<AlpacaSignInCard activeEnv="PROD" />));
    await flush();

    expect(container.textContent).toContain("Live trading");
    expect(container.textContent).toContain("Use the live key for this environment");

    setInput("apiKey", "PKLIVE88888888");
    setInput("secretKey", "live-shhh-secret");
    submit();
    await flush();

    const postCall = calls.find((call) => call.init?.method === "POST");
    expect(postCall).toBeDefined();
    const headers = postCall?.init?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("test-csrf-token-1234");
    expect(postCall?.url).toContain("environment=PROD");

    const payload = JSON.parse(String(postCall?.init?.body));
    expect(payload.environment).toBe("PROD");
    expect(payload.apiKey).toBe("PKLIVE88888888");
  });

  it("sends CSRF header on POST /broker/disconnect/alpaca", async () => {
    const calls = mockRoutes({
      "/broker/connect/alpaca": () => ({
        status: 200,
        body: {
          side: "live",
          configured: true,
          signedIn: true,
          source: "user",
          keyIdLast4: "8888",
          storedAt: "2026-11-05T00:00:00.000Z",
        },
      }),
      "/broker/disconnect/alpaca": () => ({
        status: 200,
        body: LIVE_STATUS,
      }),
    });

    act(() => root.render(<AlpacaSignInCard activeEnv="PROD" />));
    await flush();

    const signOut = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("Sign out"),
    ) as HTMLButtonElement;
    act(() => signOut.click());
    await flush();

    const disconnectCall = calls.find((call) => call.url.includes("/broker/disconnect/alpaca"));
    expect(disconnectCall).toBeDefined();
    const headers = disconnectCall?.init?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("test-csrf-token-1234");
  });

  it("dynamically queries environment on activeEnv prop change", async () => {
    const calls = mockRoutes({
      "/broker/connect/alpaca": (init) => {
        return { status: 200, body: PAPER_STATUS };
      },
    });

    act(() => root.render(<AlpacaSignInCard activeEnv="TEST" />));
    await flush();
    expect(calls.some((c) => c.url.includes("environment=TEST"))).toBe(true);

    act(() => root.render(<AlpacaSignInCard activeEnv="PROD" />));
    await flush();
    expect(calls.some((c) => c.url.includes("environment=PROD"))).toBe(true);
  });
});
