/**
 * Issue #3418 (epic #3416) — the Voice and Omnichannel desks follow the broker.
 *
 * What these tests defend:
 *   1. The voice desk's title, its welcome sentence and its transcript speaker
 *      name the SELECTED broker. Before, all three said "E*TRADE" for every
 *      tenant, and no capability check could catch it: a name is not a
 *      capability.
 *   2. The omnichannel desk's bot handle, execution sentence and status badge
 *      follow the selection, so an Alpaca tenant is not told their orders are
 *      authorised "before live E*TRADE execution".
 *   3. E*TRADE keeps its own words on its own broker — the fix is neutrality,
 *      not erasure.
 *
 * The selection is driven through the public client seam
 * (`saveTenantProviders`), which is the same cache the app renders from. No
 * private test hook is used, so this suite also passes on a tree where the
 * #3417 helpers do not exist.
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

/** React inserts `<!-- -->` between adjacent text nodes; strip it to read prose. */
function textOf(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Voice desk follows the selected broker (#3418)", () => {
  it("names Alpaca's desk, welcome and speaker", async () => {
    await selectBroker("alpaca");
    const text = textOf(renderHub("voice"));

    expect(text).toContain("Alpaca Voice Trading Desk");
    expect(text).toContain("Welcome to the Alpaca Voice Trading Desk.");
    expect(text).toContain("Alpaca Voice Desk");
    expect(text).not.toContain("E*TRADE Voice Trading Desk");
    expect(text).not.toContain("E*TRADE Voice Desk");
  });

  it("keeps E*TRADE's own desk for E*TRADE", async () => {
    await selectBroker("etrade");
    const text = textOf(renderHub("voice"));

    expect(text).toContain("E*TRADE Voice Trading Desk");
    expect(text).toContain("E*TRADE Voice Desk");
    expect(text).not.toContain("Alpaca Voice Trading Desk");
  });
});

describe("Omnichannel desk follows the selected broker (#3418)", () => {
  it("names Alpaca's bot, execution copy and status badge", async () => {
    await selectBroker("alpaca");
    const text = textOf(renderHub("omnichannel"));

    expect(text).toContain("AlpacaAgent");
    expect(text).toContain("before live Alpaca execution");
    expect(text).toContain("✓ Alpaca REST API");
    expect(text).toContain("Alpaca market update");
    expect(text).not.toContain("ETradeAgent");
    expect(text).not.toContain("before live E*TRADE execution");
  });

  it("keeps E*TRADE's bot and copy for E*TRADE", async () => {
    await selectBroker("etrade");
    const text = textOf(renderHub("omnichannel"));

    expect(text).toContain("ETradeAgent");
    expect(text).toContain("before live E*TRADE execution");
    expect(text).toContain("✓ E*TRADE REST API");
    expect(text).not.toContain("AlpacaAgent");
  });

  it("describes an unrecognised broker without naming one", async () => {
    await selectBroker("some_new_broker");
    const text = textOf(renderHub("omnichannel"));

    expect(text).not.toContain("ETradeAgent");
    expect(text).not.toContain("before live E*TRADE execution");
    expect(text).toContain("TradingAgent");
  });
});
