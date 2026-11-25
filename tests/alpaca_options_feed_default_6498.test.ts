// @vitest-environment node
/**
 * Issue 6498 (#6237 RCA) — the Alpaca options feed has a documented
 * `indicative` default; the shared config builder now implements it, and the
 * snapshots request carries the required `feed` parameter.
 *
 * Pins:
 * - 6498-P01 no `ALPACA_OPTIONS_FEED` → `indicative`;
 * - 6498-P02 an explicit env value wins (e.g. `opra`);
 * - 6498-P03 an empty env value is treated as unset → `indicative`;
 * - 6498-P04 `fetchAlpacaOptionSnapshots` sends `feed=indicative` when the
 *   config was built without the env var (the request the failed job never
 *   made).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAlpacaOptionsConfig,
  fetchAlpacaOptionSnapshots,
} from "../src/trading/alpaca/optionsData";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Alpaca options feed default (issue 6498)", () => {
  it("P01: defaults to indicative when the env var is absent", () => {
    expect(buildAlpacaOptionsConfig(undefined).feed).toBe("indicative");
    expect(buildAlpacaOptionsConfig({} as Env).feed).toBe("indicative");
  });

  it("P02: an explicit feed wins", () => {
    expect(
      buildAlpacaOptionsConfig({ ALPACA_OPTIONS_FEED: "opra" } as Env).feed,
    ).toBe("opra");
  });

  it("P03: an empty env value is treated as unset", () => {
    expect(
      buildAlpacaOptionsConfig({ ALPACA_OPTIONS_FEED: "" } as Env).feed,
    ).toBe("indicative");
  });

  it("P04: the snapshots request carries feed=indicative", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ snapshots: {} }),
          text: async () => "",
        } as unknown as Response;
      }),
    );

    await fetchAlpacaOptionSnapshots(
      buildAlpacaOptionsConfig(undefined),
      "AAPL",
      ["AAPL260116C00150000"],
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1beta1/options/snapshots/AAPL");
    expect(urls[0]).toContain("feed=indicative");
  });
});
