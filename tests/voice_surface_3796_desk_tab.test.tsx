/**
 * Issue #3796 — companion to tests/voice_surface_3796.test.tsx:
 * the Trading Desk voice tab renders on the shared voice seam.
 *
 * Server-rendered (the #3429 notice suite's harness — this file
 * deliberately runs in the default node environment, not jsdom,
 * because the hub SSR path is not jsdom-safe). The tab's mic
 * control must be present for a desk-broker tenant after the
 * #3796 refactor moved the tab onto createSurfaceVoiceBackend;
 * the #3429 notice behavior itself is pinned by
 * channel_desk_notice_3429.test.tsx, unchanged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";


import React from "react";
import ReactDOMServer from "react-dom/server";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui";
import { saveTenantProviders } from "../src/client/tenantProviders";

describe("issue #3796 — the Trading Desk voice tab renders its controls (desk-broker tenant)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the voice pane renders the mic control for a desk-broker tenant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ brokerId: "etrade", dataProviderId: "etrade" }),
      })),
    );
    await saveTenantProviders({ brokerId: "etrade", dataProviderId: "etrade" });
    const html = ReactDOMServer.renderToString(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ETradeTradingHub, {
          activeSubTab: "voice",
          user: { login: "test_user", name: "Test User" },
        }),
      ),
    );
    expect(html).toContain("Push to Talk / Speak");
    expect(html).toContain("Live Voice Conversation History");
  });
});
