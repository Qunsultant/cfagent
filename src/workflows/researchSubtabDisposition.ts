/**
 * Issue #2890 (under #2764) — MarketDataResearchHub subtab
 * dispositions to the canonical lifecycle.
 *
 * The 7 subtabs already exist as UI (useUrlSyncedTabs, param
 * "view", default "screener"). This module dispositions their
 * DATA paths; it creates no tabs and reroutes no live view
 * through a lifecycle it never had:
 *
 *   - "canonical-screen": the subtab screens, and its route
 *     runs the canonical spec/broker/planner/finalizer.
 *     Exactly one subtab holds this disposition (screener).
 *   - "replayable-research": the subtab shows research, not
 *     screens. Live generation stays live (forcing it
 *     through the screen lifecycle would change its
 *     semantics); its stored counterpart replays through
 *     the canonical replay endpoint.
 *   - "live-research-view": the subtab reads live market
 *     data, produces no run, persists no result, delivers
 *     nothing. It stays on its market-data endpoint with
 *     provenance shown; rerouting it through the screen
 *     lifecycle would invent runs and deliveries it never
 *     had.
 *
 * Invariant, pinned in tests: after this slice, no subtab
 * runs an uncanonical screen path — the only screening
 * subtab runs the canonical route, and every other subtab
 * is explicitly a non-screen.
 */

export type ResearchSubtabDisposition =
  | "canonical-screen"
  | "replayable-research"
  | "live-research-view";

export interface ResearchSubtab {
  id: string;
  /** The data path the subtab actually calls (grounded in MarketDataResearchHub). */
  dataPath: string;
  disposition: ResearchSubtabDisposition;
  /** Canonical components for this disposition (empty = deliberately none: a live view). */
  canonical: string[];
  /** Why this disposition, in one line. */
  note: string;
}

export const RESEARCH_SUBTABS: readonly ResearchSubtab[] = [
  {
    id: "screener",
    dataPath: "GET /api/market-data/screen",
    disposition: "canonical-screen",
    canonical: ["stockScreenRunSpec", "screenExecutionBroker", "stockScreenPlanner", "screenRunFinalize"],
    note: "Normalized in Slice 1: market-data source, deliver false, provider yahoo, persist-only.",
  },
  {
    id: "report",
    dataPath: "GET /api/market-data/research + POST /api/reports/replay (symbol)",
    disposition: "replayable-research",
    canonical: ["reportReplay (newest stored research report for the symbol, verbatim)"],
    note: "Live generation stays live (research, not a screen); stored reports replay from persisted data (#2863).",
  },
  {
    id: "quoting",
    dataPath: "GET /api/market-data/quote (yfinance + alpaca)",
    disposition: "live-research-view",
    canonical: [],
    note: "Live quotes for one symbol; no run, no persistence, no delivery — not a screen.",
  },
  {
    id: "fundamentals",
    dataPath: "GET /api/market-data/fundamentals",
    disposition: "live-research-view",
    canonical: [],
    note: "Live fundamentals for one symbol; no run, no persistence, no delivery — not a screen.",
  },
  {
    id: "bars",
    dataPath: "GET /api/market-data/bars",
    disposition: "live-research-view",
    canonical: [],
    note: "Live historical bars for one symbol; no run, no persistence, no delivery — not a screen.",
  },
  {
    id: "snapshot",
    dataPath: "GET /api/market-data/snapshot",
    disposition: "live-research-view",
    canonical: [],
    note: "Live market snapshot for one symbol; no run, no persistence, no delivery — not a screen.",
  },
  {
    id: "compare",
    dataPath: "POST /api/market-data/compare",
    disposition: "live-research-view",
    canonical: [],
    note: "Live multi-symbol comparison; no run, no persistence, no delivery — not a screen.",
  },
];

export function researchSubtabs(): readonly ResearchSubtab[] {
  return RESEARCH_SUBTABS;
}

/** Unknown ids resolve to undefined, never an invented disposition. */
export function researchSubtabById(id: string): ResearchSubtab | undefined {
  return RESEARCH_SUBTABS.find((subtab) => subtab.id === id);
}

/** The screening subtabs — the only ones that may run a screen path. */
export function screeningResearchSubtabs(): ResearchSubtab[] {
  return RESEARCH_SUBTABS.filter((subtab) => subtab.disposition === "canonical-screen");
}
