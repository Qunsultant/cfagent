/** @vitest-environment jsdom */
/**
 * Issue #1159: E*TRADE OAuth start failures were invisible on the hub —
 * oauthMsg rendered only inside the PIN modal, which opens only on
 * success — and the authorization popup opened after an async fetch,
 * which browsers block. These tests pin the fix:
 * - a failed OAuth start surfaces a top-level hub banner (modal closed);
 * - the authorization tab opens synchronously, and a blocked popup
 *   yields a high-visibility fallback link instead of silence;
 * - a sandbox-indicating failure offers Switch to TEST & Connect.
 *
 * Harness follows tests/etradeDisconnect2386.test.tsx: hub rendered in
 * ToastProvider, stubbed fetch, OAuth start triggered via the
 * "start-etrade-oauth" window event the hub listens for.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let originalOpen: typeof window.open;

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderHub() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <ETradeTradingHub />
      </ToastProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  originalOpen = window.open;
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  window.open = originalOpen;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type StartMode =
  | { kind: "fail"; error: string }
  | { kind: "ok"; authorizeUrl: string };

function mockFetch(start: StartMode) {
  const calls: Array<{ url: string; env?: string }> = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const env = init?.headers?.["x-environment"];
    calls.push({ url, env });
    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/etrade/oauth/start")) {
      if (start.kind === "fail") {
        return { ok: false, status: 401, json: async () => ({ error: start.error }) };
      }
      return okJson({ authorizeUrl: start.authorizeUrl, requestToken: "rt", requestTokenSecret: "rs" });
    }
    if (url.startsWith("/api/etrade/oauth/status")) {
      return okJson({ authenticated: false, environment: "TEST", renewable: false });
    }
    if (url.startsWith("/api/etrade/status")) {
      return okJson({ oauthAuthenticated: false, activeEnvironment: "TEST", environment: "TEST", configured: true, hasApiKey: true });
    }
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function startOAuth() {
  await act(async () => {
    window.dispatchEvent(new Event("start-etrade-oauth"));
  });
  await flush(80);
}

describe("E*TRADE OAuth hub feedback (#1159)", () => {
  it("failed OAuth start surfaces a top-level hub banner, not just the modal", async () => {
    mockFetch({ kind: "fail", error: "401 sandbox credentials against live production" });
    await renderHub();
    await startOAuth();
    expect(container.textContent).toMatch(/401 sandbox credentials against live production/);
    expect(container.textContent).not.toMatch(/Authorize E\*TRADE Application/);
  });

  it("blocked popup stays reachable after the PIN modal is dismissed", async () => {
    mockFetch({ kind: "ok", authorizeUrl: "https://api.etrade.com/oauth/authorize?token=rt" });
    window.open = vi.fn(() => null) as any;
    await renderHub();
    await startOAuth();
    // The modal itself links the URL while open; dismiss it and the
    // hub banner must keep the link reachable.
    const cancel = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("Cancel"),
    );
    await act(async () => {
      (cancel as HTMLButtonElement).click();
    });
    await flush(40);
    const link = container.querySelector('a[href="https://api.etrade.com/oauth/authorize?token=rt"]');
    expect(link).not.toBeNull();
  });

  it("allowed popup navigates synchronously", async () => {
    mockFetch({ kind: "ok", authorizeUrl: "https://api.etrade.com/oauth/authorize?token=rt" });
    const tab = { location: { href: "" }, close: vi.fn() };
    const openMock = vi.fn(() => tab);
    window.open = openMock as any;
    await renderHub();
    await startOAuth();
    expect(openMock).toHaveBeenCalled();
    expect(tab.location.href).toBe("https://api.etrade.com/oauth/authorize?token=rt");
  });

  it("sandbox-indicating failure offers Switch to TEST & Connect", async () => {
    const calls = mockFetch({ kind: "fail", error: "SANDBOX key used against live; switch environment to TEST" });
    await renderHub();
    await startOAuth();
    const buttons = [...container.querySelectorAll("button")];
    const switchBtn = buttons.find((b) => (b.textContent || "").includes("Switch to TEST"));
    expect(switchBtn).toBeDefined();
    const startsBefore = calls.filter((c) => c.url.startsWith("/api/etrade/oauth/start")).length;
    await act(async () => {
      (switchBtn as HTMLButtonElement).click();
    });
    await flush(80);
    const startsAfter = calls.filter((c) => c.url.startsWith("/api/etrade/oauth/start")).length;
    expect(startsAfter).toBeGreaterThan(startsBefore);
  });
});
