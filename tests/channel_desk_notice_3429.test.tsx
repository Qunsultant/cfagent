/**
 * Issue #3429 — the refusal is stated on the surface, before the tenant types
 * a command.
 *
 * The backend gate is the safety fix; this suite pins its user-facing half, so
 * an Alpaca tenant reading the Omnichannel or Voice tab is told that the desks
 * execute at E*TRADE rather than discovering it after sending a command. An
 * E*TRADE tenant must not see the notice at all.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui";
import { saveTenantProviders } from "../src/client/tenantProviders";

async function selectBroker(brokerId: string): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ brokerId, dataProviderId: brokerId }),
    })),
  );
  await saveTenantProviders({ brokerId, dataProviderId: brokerId });
}

function renderHub(activeSubTab: "voice" | "omnichannel"): string {
  return ReactDOMServer.renderToString(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ETradeTradingHub, {
        activeSubTab,
        user: { login: "test_user", name: "Test User" },
      }),
    ),
  );
}

function textOf(html: string): string {
  return html.split("<!-- -->").join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel desk notice (#3429)", () => {
  it("tells an Alpaca tenant the omnichannel desks execute at E*TRADE", async () => {
    await selectBroker("alpaca");
    const text = textOf(renderHub("omnichannel"));
    expect(text).toContain("Alpaca does not run these desks");
    expect(text).toContain("execute against E*TRADE");
  });

  it("tells an Alpaca tenant the voice desk executes at E*TRADE", async () => {
    await selectBroker("alpaca");
    const text = textOf(renderHub("voice"));
    expect(text).toContain("Alpaca does not run the voice desk");
    expect(text).toContain("executes against E*TRADE");
  });

  it("does not show the notice to an E*TRADE tenant", async () => {
    await selectBroker("etrade");
    expect(textOf(renderHub("omnichannel"))).not.toContain("does not run these desks");
    expect(textOf(renderHub("voice"))).not.toContain("does not run the voice desk");
  });
});
