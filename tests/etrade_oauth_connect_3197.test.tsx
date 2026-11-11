/** @vitest-environment jsdom */
/**
 * Issue #3197: broker connect must never strand a bare about:blank
 * tab, and the blocked-popup banner link must not invalidate the PIN
 * it hands the user.
 *
 * Pins:
 * - start failure with an unclosable pre-opened tab navigates that
 *   tab back to the app with an outcome code (etrade_connect_error),
 *   instead of leaving a blank tab;
 * - start failure with a closable tab closes it and does not
 *   navigate it anywhere;
 * - a server outcome code on start failure rides the tab URL and
 *   the banner shows the server's outcome message;
 * - blocked popup -> banner button -> PIN modal re-opens bound to
 *   the ORIGINAL request token with NO second /start call, so the
 *   PIN obtained from the banner link still submits (comment
 *   6635403540 regression);
 * - landing with ?etrade_connect_error=<outcome code> shows the
 *   catalog business message in the hub banner.
 *
 * Harness follows tests/etrade_oauth_banner_1159.test.tsx: hub
 * rendered in ToastProvider, stubbed fetch, OAuth start triggered
 * via the "start-etrade-oauth" window event.
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
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type StartMode =
  | { kind: "fail"; error: string; code?: string }
  | { kind: "ok"; authorizeUrl: string };

function mockFetch(start: StartMode) {
  const calls: Array<{ url: string; env?: string; body?: any }> = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const env = init?.headers?.["x-environment"];
    let body: any;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, env, body });
    const okJson = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
    if (url.startsWith("/api/etrade/oauth/start")) {
      if (start.kind === "fail") {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: start.error, code: start.code }),
        };
      }
      return okJson({ authorizeUrl: start.authorizeUrl, requestToken: "rt", requestTokenSecret: "rs" });
    }
    if (url.startsWith("/api/etrade/oauth/verifier")) {
      return okJson({ success: true });
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

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes(text),
  ) as HTMLButtonElement | undefined;
}

async function clickButton(text: string) {
  const btn = findButton(text);
  expect(btn, `expected a button containing: ${text}`).toBeDefined();
  await act(async () => {
    (btn as HTMLButtonElement).click();
  });
  await flush(40);
}

describe("Broker connect stranded-tab + banner-link trap (#3197)", () => {
  it("start failure with an unclosable tab navigates it to the app with an outcome code", async () => {
    mockFetch({ kind: "fail", error: "upstream exploded" });
    const tab = { location: { href: "" }, close: vi.fn(), closed: false };
    window.open = vi.fn(() => tab) as any;
    await renderHub();
    await startOAuth();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toContain("etrade_connect_error=FAILURE_ETRADE_OAUTH_START_FAILED");
  });

  it("start failure with a closable tab closes it and navigates nowhere", async () => {
    mockFetch({ kind: "fail", error: "upstream exploded" });
    const tab: any = { location: { href: "" }, closed: false };
    tab.close = vi.fn(() => {
      tab.closed = true;
    });
    window.open = vi.fn(() => tab) as any;
    await renderHub();
    await startOAuth();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe("");
  });

  it("start failure carries the server outcome code onto the tab URL and the banner", async () => {
    mockFetch({
      kind: "fail",
      error: "[FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED] E*TRADE rejected the authorization request.",
      code: "FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED",
    });
    const tab = { location: { href: "" }, close: vi.fn(), closed: false };
    window.open = vi.fn(() => tab) as any;
    await renderHub();
    await startOAuth();
    expect(tab.location.href).toContain(
      "etrade_connect_error=FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED",
    );
    expect(container.textContent).toMatch(/\[FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED\]/);
  });

  it("blocked popup -> banner button re-opens the PIN modal bound to the original token, no second start", async () => {
    const calls = mockFetch({ kind: "ok", authorizeUrl: "https://api.etrade.com/oauth/authorize?token=rt" });
    window.open = vi.fn(() => null) as any;
    await renderHub();
    await startOAuth();
    // The PIN modal renders through a portal to document.body, so
    // modal content is asserted document-wide, not via container.
    expect(document.body.textContent).toMatch(/Authorize E\*TRADE Application/);
    // Dismiss the modal; the banner must offer the way back.
    await clickButton("Cancel");
    expect(document.body.textContent).not.toMatch(/Authorize E\*TRADE Application/);
    const startsBefore = calls.filter((c) => c.url.startsWith("/api/etrade/oauth/start")).length;
    await clickButton("Reopen PIN form");
    expect(document.body.textContent).toMatch(/Authorize E\*TRADE Application/);
    const startsAfter = calls.filter((c) => c.url.startsWith("/api/etrade/oauth/start")).length;
    expect(startsAfter).toBe(startsBefore);
    // The re-opened modal still links the ORIGINAL authorize URL.
    const modalLink = document.querySelector('a[href="https://api.etrade.com/oauth/authorize?token=rt"]');
    expect(modalLink).not.toBeNull();
    // Submit the banner-link PIN against the original token.
    // The PIN input lost its .pin-input class in the S-U2 (#3051)
    // migration (steps now use Flex + Badge numbers); query the
    // TextInput by its placeholder instead.
    const input = document.querySelector(
      'input[placeholder*="Verification Code"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "ABC1234");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush(20);
    await clickButton("Complete Authorization");
    await flush(80);
    const verifierCalls = calls.filter((c) => c.url.startsWith("/api/etrade/oauth/verifier"));
    expect(verifierCalls).toHaveLength(1);
    expect(verifierCalls[0].body.requestToken).toBe("rt");
    expect(calls.filter((c) => c.url.startsWith("/api/etrade/oauth/start"))).toHaveLength(1);
  });

  it("landing with etrade_connect_error shows the catalog business message", async () => {
    mockFetch({ kind: "fail", error: "unused" });
    window.history.pushState({}, "", "/?etrade_connect_error=FAILURE_ETRADE_OAUTH_START_FAILED");
    await renderHub();
    expect(container.textContent).toMatch(/E\*TRADE authorization could not be started/);
  });
});

/**
 * #3197 root cause (found 2026-11-05): the pre-open used
 * `window.open("", "_blank", "noopener,noreferrer")`. Per the HTML spec a
 * `noopener` (or `noreferrer`, which implies it) request makes `window.open`
 * return **null**, so `authTab` was always null: the success path could never
 * navigate the tab and the failure reclaim was dead code. The tab therefore
 * always stayed on about:blank, which is what the user reported.
 *
 * These tests stub window.open the way a browser actually behaves, so the
 * regression cannot hide behind a fake handle again.
 */
describe("E*TRADE connect: the pre-opened tab is reachable and never stranded (#3197)", () => {
  /** Spec-accurate stub: noopener/noreferrer returns null (MDN window.open). */
  function specAccurateOpen(tab: any) {
    return vi.fn((_url?: string, _target?: string, features?: string) => {
      const f = String(features || "");
      if (/(^|,)\s*(noopener|noreferrer)\b/i.test(f)) return null;
      return tab;
    });
  }

  it("navigates the pre-opened tab to the authorize URL, with the opener reference severed", async () => {
    mockFetch({ kind: "ok", authorizeUrl: "https://api.etrade.com/oauth/authorize?token=rt" });
    const tab: any = { location: { href: "about:blank" }, opener: {}, close: vi.fn(), closed: false };
    window.open = specAccurateOpen(tab) as any;
    await renderHub();
    await startOAuth();
    expect(tab.location.href).toBe("https://api.etrade.com/oauth/authorize?token=rt");
    // The handle is only usable because opener is nulled explicitly instead
    // of asking the browser to do it (which costs us the handle).
    expect(tab.opener).toBeNull();
  });

  it("a failed start closes the tab instead of leaving it on about:blank", async () => {
    mockFetch({ kind: "fail", error: "upstream exploded" });
    const tab: any = { location: { href: "about:blank" }, opener: {}, closed: false };
    tab.close = vi.fn(() => {
      tab.closed = true;
    });
    window.open = specAccurateOpen(tab) as any;
    await renderHub();
    await startOAuth();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe("about:blank");
  });

  it("a genuinely blocked popup still offers the in-app fallback link", async () => {
    const calls = mockFetch({ kind: "ok", authorizeUrl: "https://api.etrade.com/oauth/authorize?token=rt" });
    window.open = vi.fn(() => null) as any;
    await renderHub();
    await startOAuth();
    expect(calls.filter((c) => c.url.startsWith("/api/etrade/oauth/start"))).toHaveLength(1);
    expect(document.body.textContent).toMatch(/Authorize E\*TRADE Application/);
    const modalLink = document.querySelector('a[href="https://api.etrade.com/oauth/authorize?token=rt"]');
    expect(modalLink).not.toBeNull();
  });
});
