import { afterEach, describe, expect, it, vi } from "vitest";
import * as eventCalendar from "../src/services/eventCalendar";
import { PlatformResearchDataProvider } from "../src/services/researchProviders";

describe("3737 research pipeline catalyst feed wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps covered earnings and ex-dividend dates into CatalystInfo[]", async () => {
    vi.spyOn(eventCalendar, "getSymbolEventCalendar").mockResolvedValue({
      symbol: "AAPL",
      covered: true,
      source: eventCalendar.EVENT_CALENDAR_SOURCE,
      earningsDate: "2026-12-01",
      daysToEarnings: 12,
      exDividendDate: "2026-11-25",
      daysToExDiv: 6,
      fetchedAt: "2026-11-19T12:00:00.000Z",
    });

    const provider = new PlatformResearchDataProvider({} as any, "owner");
    const catalysts = await provider.getCatalysts("AAPL");
    expect(catalysts).toEqual([
      {
        description: "Upcoming earnings on 2026-12-01 (12d)",
        date: "2026-12-01",
        direction: "neutral",
      },
      {
        description: "Upcoming ex-dividend on 2026-11-25 (6d)",
        date: "2026-11-25",
        direction: "neutral",
      },
    ]);
  });

  it("returns empty array when covered with no upcoming events, and null when uncovered", async () => {
    const spy = vi.spyOn(eventCalendar, "getSymbolEventCalendar");
    spy.mockResolvedValueOnce({
      symbol: "MSFT",
      covered: true,
      source: eventCalendar.EVENT_CALENDAR_SOURCE,
      earningsDate: null,
      daysToEarnings: null,
      exDividendDate: null,
      daysToExDiv: null,
      fetchedAt: "2026-11-19T12:00:00.000Z",
    });

    const provider = new PlatformResearchDataProvider({} as any, "owner");
    expect(await provider.getCatalysts("MSFT")).toEqual([]);

    spy.mockResolvedValueOnce({
      symbol: "NVDA",
      covered: false,
      source: eventCalendar.EVENT_CALENDAR_SOURCE,
      earningsDate: null,
      daysToEarnings: null,
      exDividendDate: null,
      daysToExDiv: null,
      fetchedAt: "2026-11-19T12:00:00.000Z",
    });
    expect(await provider.getCatalysts("NVDA")).toBeNull();
  });
});
