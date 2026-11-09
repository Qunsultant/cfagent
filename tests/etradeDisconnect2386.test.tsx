/** @vitest-environment jsdom */
/**
 * Issue #2386: the disconnect dialog ignored the revoke response,
 * optimistically flipped the panel to disconnected, then refetched
 * server status — snapping back to Disconnect when the server still
 * reported connected (tokens under an internal-id/alias key survived
 * the identity-less revoke). These tests pin the truthful panel:
 * - a failed revoke leaves the panel connected and surfaces the
 *   failure (never an optimistic flip, never a snap-back);
 * - a confirmed revoke flips the panel to disconnected;
 * - the broker-status read never overwrites the oauth/status flag
 *   (oauth/status is the sole writer of oauthStatus).
 *
 * Harness follows tests/autopilot_control_center_state.test.tsx:
 * react-dom/client in jsdom, stubbed fetch, panel state observed via
 * the onBrokerPropsChange callback the hub reports to its menu.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { setTenantProvidersStateForTest } from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  // Issue #3812: the platform default broker is Alpaca; this panel test
  // exercises the E*TRADE surface, so the selection is explicit.
  setTenantProvidersStateForTest({ dataProviderId: "etrade", brokerId: "etrade" });
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type RevokeMode = "fail" | "ok";

interface CapturedProps {
  oauthStatus?: { authenticated?: boolean };
  oauthMsg?: string;
}

function mockFetch(opts: { revokeMode: RevokeMode; brokerAuthenticated: boolean }) {
  let statusAuthenticated = true;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${url}`);
    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/etrade/oauth/status") && method === "GET") {
      return okJson({ authenticated: statusAuthenticated, environment: "TEST", renewable: true });
    }
    if (url.startsWith("/api/etrade/oauth/revoke") && method === "POST") {
      if (opts.revokeMode === "fail") {
        return { ok: false, status: 500, json: async () => ({ error: "revoke failed" }) };
      }
      statusAuthenticated = false;
      return okJson({ success: true, deleted: true });
    }
    if (url.startsWith("/api/etrade/status")) {
      return okJson({
        oauthAuthenticated: opts.brokerAuthenticated,
        activeEnvironment: "TEST",
        environment: "TEST",
        configured: true,
        hasApiKey: true,
      });
    }
    if (url.startsWith("/api/etrade/positions")) return okJson({ account: null, positions: [] });
    if (url.startsWith("/api/etrade/orders")) return okJson({ orders: [] });
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, getStatusAuthenticated: () => statusAuthenticated };
}

function findButtonByText(text: string): HTMLButtonElement | null {
  // The disconnect dialog is a Modal, which portals to document.body.
  const buttons = Array.from(document.querySelectorAll("button"));
  return (buttons.find((b) => b.textContent?.trim() === text) as HTMLButtonElement) ?? null;
}

async function openDisconnectDialog() {
  await act(async () => {
    window.dispatchEvent(new Event("revoke-etrade-oauth"));
  });
  await flush();
  expect(document.body.textContent).toContain("Disconnect E*TRADE account?");
}

async function clickModalDisconnect() {
  const button = findButtonByText("Disconnect");
  expect(button).not.toBeNull();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush(80);
}

describe("E*TRADE disconnect panel truthfulness (#2386)", () => {
  it("failed revoke keeps the panel connected and surfaces the failure", async () => {
    mockFetch({ revokeMode: "fail", brokerAuthenticated: true });
    const captured: CapturedProps[] = [];
    await render(
      <ETradeTradingHub
        onBrokerPropsChange={(props) =>
          captured.push({ oauthStatus: props.oauthStatus, oauthMsg: props.oauthMsg })
        }
      />,
    );
    expect(captured.some((p) => p.oauthStatus?.authenticated === true)).toBe(true);

    await openDisconnectDialog();
    await clickModalDisconnect();

    // Never flipped to disconnected, even transiently.
    expect(captured.some((p) => p.oauthStatus?.authenticated === false)).toBe(false);
    expect(captured.some((p) => p.oauthStatus?.authenticated === true)).toBe(true);
    const last = captured[captured.length - 1];
    expect(last.oauthMsg ?? "").toMatch(/fail|error|could not/i);
  });

  it("confirmed revoke flips the panel to disconnected", async () => {
    mockFetch({ revokeMode: "ok", brokerAuthenticated: true });
    const captured: CapturedProps[] = [];
    await render(
      <ETradeTradingHub
        onBrokerPropsChange={(props) =>
          captured.push({ oauthStatus: props.oauthStatus, oauthMsg: props.oauthMsg })
        }
      />,
    );
    expect(captured.some((p) => p.oauthStatus?.authenticated === true)).toBe(true);

    await openDisconnectDialog();
    await clickModalDisconnect();

    expect(captured.some((p) => p.oauthStatus?.authenticated === false)).toBe(true);
    const last = captured[captured.length - 1];
    expect(last.oauthMsg ?? "").toMatch(/disconnected/i);
  });

  it("broker status never overwrites the oauth/status flag", async () => {
    mockFetch({ revokeMode: "ok", brokerAuthenticated: false });
    const captured: CapturedProps[] = [];
    await render(
      <ETradeTradingHub
        onBrokerPropsChange={(props) =>
          captured.push({ oauthStatus: props.oauthStatus, oauthMsg: props.oauthMsg })
        }
      />,
    );
    await flush(80);
    expect(captured.some((p) => p.oauthStatus?.authenticated === true)).toBe(true);
    expect(captured.some((p) => p.oauthStatus?.authenticated === false)).toBe(false);
  });
});
