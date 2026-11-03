import { useMemo } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  SCREENING_ASSET_CLASSES,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
import { navigateToTab } from "./router";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "./components/CapabilityNavBar";
import { ScannerPanel } from "./ScannerPanel";
import { GoalScreenPanel } from "./GoalScreenPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { IvHistoryPanel } from "./IvHistoryPanel";
import { ReportsPanel } from "./ReportsPanel";
import { PatternsPanel } from "./PatternsPanel";
import { buildAppliedPatternParams } from "./patternApplyHandoff";
import { stockPatternById } from "../workflows/stockPatternCatalog";
import { PresetsPanel } from "./PresetsPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { ScreeningReviewPanel } from "./ScreeningReviewPanel";
import { ScreeningOutcomesPanel } from "./ScreeningOutcomesPanel";
import { CalibrationDashboard } from "./CalibrationDashboard";
import { EnrichmentDashboard } from "./EnrichmentDashboard";
import { OptionsResearchHost } from "./options/OptionsResearchHost";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import "./optionsResearch.css";

/** S8 (consolidation, umbrella #958): the hub's tabs — the screening
 *  asset classes plus the folded Strategy/Symbol Scanner and IV
 *  History surfaces (formerly Trading Hub subtabs).
 *  C1 (consolidation #1151, issue #1201): the Goal Screen tab — the
 *  #1096 unified stack's surface (goal-driven screens + backtest).
 *  C2 (consolidation #1151, issue #1246): Reports and Schedules move
 *  INTO the hub as tabs (they were standalone nav entries), and the
 *  hub gains the proposal Review inbox and the recommendation Track
 *  Record — the #1096 surfaces users could not reach before.
 *  Issue #2896: the stocks tabs moved to Stock Hub; this hub keeps
 *  options, planned assets, scanner, IV history, goal screen, reports,
 *  schedules, review, and track record. */
/**
 * Issue #2545: the Stocks one-shot form's delivery selection — the
 * scheduled "Stock Market Screen" job's delivery fields, named
 * exactly as the schedule payload names them (deliveryFields in
 * src/trading/screeningSchemas.ts), plus the report flag.
 */
export interface StockRunDeliverySelection {
  pushToSlack: boolean;
  slackChannel: string;
  emailTo: string;
  webhookUrl: string;
  generatePdf: boolean;
}

/**
 * Issue #2545: the one-shot run request body — the screen filters
 * plus the delivery envelope, built with the schedule payload
 * builders' conventions: slackChannel rides only when Slack push is
 * on, blank recipients are omitted (never sent as empty strings),
 * recipients are trimmed. The server splits the envelope out of the
 * engine filter (parseStockScreenRequest) and stamps it onto the
 * run's delivery outcome, so a manual run with delivery options
 * produces the same artifacts as the scheduled run.
 */
export function buildStockRunRequestBody(
  filters: Record<string, unknown>,
  delivery: StockRunDeliverySelection,
): Record<string, unknown> {
  return {
    ...filters,
    pushToSlack: delivery.pushToSlack,
    ...(delivery.pushToSlack && delivery.slackChannel.trim()
      ? { slackChannel: delivery.slackChannel.trim() }
      : {}),
    ...(delivery.emailTo.trim() ? { emailTo: delivery.emailTo.trim() } : {}),
    ...(delivery.webhookUrl.trim() ? { webhookUrl: delivery.webhookUrl.trim() } : {}),
    generatePdf: delivery.generatePdf,
  };
}

export type ScreenersHubTab =
  | "options"
  | "forex"
  | "futures"
  | "commodities"
  | "bonds"
  | "scanner"
  | "iv-history"
  | "goal-screen"
  | "reports"
  | "schedules"
  | "review"
  | "track-record"
  | "patterns"
  | "presets";

export const SCREENER_HUB_TABS: readonly ScreenersHubTab[] = [
  "options",
  "forex",
  "futures",
  "commodities",
  "bonds",
  "scanner",
  "iv-history",
  "goal-screen",
  "reports",
  "schedules",
  "review",
  "track-record",
  "patterns",
  "presets",
] as const;

export function isValidScreenerTab(tab: unknown): tab is ScreenersHubTab {
  return typeof tab === "string" && (SCREENER_HUB_TABS as readonly string[]).includes(tab);
}

interface ScreenersHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onStocksLoaded?: (rows: ScreenedStockItem[]) => void;
  /** S8: the trade-preview handoff threaded into the folded panels —
   *  the Trading Hub passes its order-ticket handler, exactly as it
   *  did when the panels were its own subtabs. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  /** S8: the tab to open on — the Trading Hub's screening redirects
   *  deep-link into the hub with the folded surface's tab. */
  initialTab?: ScreenersHubTab;
  onTabChange?: (tab: ScreenersHubTab) => void;
}


// Issue #212: a persisted autonomous screener run.
// Issue #253: allStocks carries the full scanned set (not just standouts).
// Issue #261: trigger identifies the source for the unified UI.
// Issue #125: universe + partial mirror ScreenerRunResult so retained runs
// can be listed with their scope and status (see screenRunStatus).
interface ScreenRun {
  timestamp: string;
  pdfKey?: string;
  reportUrl?: string;
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  opportunities: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
  }>;
  allStocks?: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
    rsi14: number | null;
    source: string;
  }>;
  error?: string;
}

// Issue #125: run status, derived from the fields ScreenerRunResult
// actually carries — a failed run has success:false (+ error); a partial
// run is a success that ran on an incomplete quote set (#462 qualification);
// anything else is a clean success. Quiet runs (success, zero standouts)
// are ordinary successes — they are history, not alerts.
export type ScreenRunStatus = "success" | "partial" | "failed";

export function screenRunStatus(run: Pick<ScreenRun, "success" | "partial">): ScreenRunStatus {
  if (!run.success) return "failed";
  if (run.partial) return "partial";
  return "success";
}

export const SCREEN_RUN_STATUS_LABELS: Record<ScreenRunStatus, string> = {
  success: "Success",
  partial: "Partial",
  failed: "Failed",
};

// Issue #125: the viewed run is tracked by timestamp so a polling refresh
// that prepends a newer run never silently re-points the view at a
// different run; a selection that has aged out of the retained history
// (or no selection yet) falls back to the latest run.
export function resolveSelectedRun<T extends { timestamp: string }>(
  runs: T[],
  selectedTimestamp: string | null,
): T | undefined {
  if (selectedTimestamp) {
    const found = runs.find((run) => run.timestamp === selectedTimestamp);
    if (found) return found;
  }
  return runs[0];
}

function numberFilter(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

export function ScreenersHub({
  activeEnv,
  userLogin,
  onStocksLoaded,
  onPreviewTrade,
  onSendPrompt,
  onJobStateChange,
  initialTab,
  onTabChange,
}: ScreenersHubProps) {
  // Tabbed browsing via the shared hook (S2, #2027): canonical param is
  // `view`; `screenerTab` (and `tab`) stay as read-only legacy aliases so
  // existing bookmarks and hash links keep resolving.
  const { activeTab: hubTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<ScreenersHubTab>({
      param: "view",
      aliases: ["screenerTab", "tab"],
      isValid: isValidScreenerTab,
      defaultTab: "options",
      initialTab: initialTab ?? null,
      onTabChange,
    });

  // The provider-adapter machinery below serves the asset classes;
  // the folded scanner / iv-history tabs have no adapter, so they
  // borrow "stocks" for the (unused) provider lookups.
  const assetClass: ScreeningAssetClass =
    hubTab === "scanner" ||
    hubTab === "iv-history" ||
    hubTab === "goal-screen" ||
    hubTab === "reports" ||
    hubTab === "schedules" ||
    hubTab === "review" ||
    hubTab === "track-record" ||
    hubTab === "patterns" ||
    hubTab === "presets"
      ? "stocks"
      : hubTab;
  const screenerTabs: CapabilityTabItem[] = useMemo(() => {
    const descriptions: Record<string, { eyebrow: string; title: string; desc: string; icon: string }> = {
      options: {
        eyebrow: "DERIVATIVES SCREENING",
        title: "Options Research",
        desc: "Strategy discovery, the raw contracts screener, custom thesis scans, NLQ, and the LLM idea experiment — the full options research surface, hosted here.",
        icon: "⚡",
      },
      forex: {
        eyebrow: "CURRENCY PAIRS",
        title: "Forex Screener · Planned",
        desc: "Screen foreign exchange pairs across global FX liquidity pools (adapter in development).",
        icon: "💱",
      },
      futures: {
        eyebrow: "COMMODITY & INDEX FUTURES",
        title: "Futures Screener · Planned",
        desc: "Screen E-mini index futures, energy, metals, and treasury contracts (adapter in development).",
        icon: "📊",
      },
      commodities: {
        eyebrow: "COMMODITY BENCHMARKS",
        title: "Commodities Screener · Planned",
        desc: "Screen physical commodity and spot contracts (adapter in development).",
        icon: "🛢️",
      },
      bonds: {
        eyebrow: "FIXED INCOME",
        title: "Bonds & Yields · Planned",
        desc: "Screen US Treasuries, corporate bonds, and yield curve spreads (adapter in development).",
        icon: "🏛️",
      },
    };

    const assetTabs: CapabilityTabItem[] = SCREENING_ASSET_CLASSES.filter((asset) => asset.id !== "stocks").map((asset) => {
      const info = descriptions[asset.id] || {
        eyebrow: "MARKET SCREENER",
        title: asset.label,
        desc: `Screen ${asset.label.toLowerCase()} across connected market data providers.`,
        icon: "🔍",
      };

      return {
        id: asset.id,
        label: asset.label,
        icon: info.icon,
        badge: asset.available ? (asset.id === "stocks" ? "LIVE" : undefined) : "PLANNED",
        badgeType: asset.available ? (asset.id === "stocks" ? "live" : "default") : "amber",
        tooltip: {
          eyebrow: info.eyebrow,
          title: info.title,
          description: info.desc,
        },
      };
    });

    // S8: the folded surfaces ride the same tab bar, right after
    // Options — the Strategy/Symbol Scanner and IV History, formerly
    // Trading Hub subtabs.

    const optionsIndex = assetTabs.findIndex((tab) => tab.id === "options");
    assetTabs.splice(optionsIndex + 1, 0,
      {
        id: "scanner",
        label: "Strategy Scanner",
        icon: "🎯",
        badge: "AI",
        badgeType: "purple",
        tooltip: {
          eyebrow: "STRATEGY / SYMBOL SCANNING",
          title: "Strategy/Symbol Scanner",
          description: "Best strategy for a name, or names that fit your strategy — across the full strategy catalog.",
        },
      },
      {
        id: "iv-history",
        label: "IV History",
        icon: "📈",
        tooltip: {
          eyebrow: "IMPLIED VOLATILITY",
          title: "IV History",
          description: "Daily option-chain IV snapshots: per-symbol coverage, IV rank, and the latest readings.",
        },
      },
      {
        // C1 (consolidation #1151, issue #1201): the goal-driven
        // screen — one goal, one screen across stocks + options
        // through the unified screening stack, with backtest-on-screen.
        id: "goal-screen",
        label: "Goal Screen",
        icon: "🧭",
        badge: "AI",
        badgeType: "purple",
        tooltip: {
          eyebrow: "GOAL-DRIVEN SCREENING",
          title: "Goal Screen",
          description: "Pick a goal; the unified screening stack screens stocks and options for it — and can backtest the hits.",
        },
      },
    );
    // C2 (consolidation #1151, issue #1246): the hub's own surfaces —
    // Reports and Schedules (formerly standalone nav entries) and the
    // #1096 Review inbox + recommendation Track Record.
    assetTabs.push(
      {
        id: "reports",
        label: "Reports",
        icon: "📄",
        tooltip: {
          eyebrow: "SCREENING REPORTS",
          title: "Reports",
          description: "Generated screening reports — view, download, and regenerate them here.",
        },
      },
      {
        id: "schedules",
        label: "Schedules",
        icon: "🗓️",
        tooltip: {
          eyebrow: "SCREENING SCHEDULES",
          title: "Schedules",
          description: "The one scheduling surface for screening runs — create, pause, and inspect scheduled jobs.",
        },
      },
      {
        id: "review",
        label: "Review",
        icon: "🧾",
        badge: "AI",
        badgeType: "purple",
        tooltip: {
          eyebrow: "PROPOSAL REVIEW",
          title: "Proposal Review",
          description: "Decide what the system proposed: goal proposals, adaptation candidates, and strategy re-selections — nothing activates without a person.",
        },
      },
      {
        id: "track-record",
        label: "Track Record",
        icon: "📈",
        tooltip: {
          eyebrow: "RECOMMENDATION OUTCOMES",
          title: "Track Record",
          description: "What happened to issued recommendations, from the outcome ledger — Unverified stays Unverified.",
        },
      },
      {
        // Issue #2884: the stock pattern catalog — read-only in
        // v1, select/apply to New Screen. Patterns stay separate
        // from presets; this tab never touches preset storage.
        id: "patterns",
        label: "Patterns",
        icon: "🧩",
        tooltip: {
          eyebrow: "STOCK PATTERN CATALOG",
          title: "Patterns",
          description: "Stock market setup signatures from the setup catalog — read-only, apply one to a new screen.",
        },
      },
      {
        // Issue #2886: the presets catalog — My Presets plus
        // proposed starters (copy-to-mine). Presets stay
        // separate from patterns; this tab never touches
        // pattern definitions.
        id: "presets",
        label: "Presets",
        icon: "💾",
        tooltip: {
          eyebrow: "PRESET CATALOG",
          title: "Presets",
          description: "Your saved screening configurations, plus proposed starter presets to copy to My Presets.",
        },
      },
    );
    // Issue #2783: the #2438 exclusion is removed — the Planned tabs
    // return to the primary bar with their PLANNED badges (nothing
    // hidden); the left-nav Planned menu links to the same views.
    return assetTabs;
  }, []);

  return (
    <section className="trading-section screeners-hub">
      <CapabilityNavBar
        ariaLabel="Instrument class capabilities"
        tabs={screenerTabs}
        activeTabId={hubTab}
        onTabChange={handleTabChange}
        rightContent={
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            {/* Issue #2438: the header shows the selected run's identity
                or nothing — never manual-run leftovers ("Last scan" /
                "N matched" described a manual run the user may never
                have made, above autonomous content). */}
          </div>
        }
      />

      {/* Tabbed Browsing Panels — reference multi-tab state retention:
          Panels mount on first visit and stay preserved in the DOM with role="tabpanel",
          id, and aria-labelledby linking back to their corresponding tab button. */}

      {/* 2. Options Research Panel */}
      {visitedTabs.has("options") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-options"
          aria-labelledby="cap-tab-options"
          hidden={hubTab !== "options"}
          style={hubTab !== "options" ? { display: "none" } : undefined}
        >
          <OptionsResearchHost
            activeEnv={activeEnv}
            userLogin={userLogin}
            onPreviewTrade={onPreviewTrade}
            onJobStateChange={onJobStateChange}
            onSendPrompt={onSendPrompt}
            onOpenSchedules={() => handleTabChange("schedules")}
          />
        </div>
      )}

      {/* 3. Strategy/Symbol Scanner Panel */}
      {visitedTabs.has("scanner") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-scanner"
          aria-labelledby="cap-tab-scanner"
          hidden={hubTab !== "scanner"}
          style={hubTab !== "scanner" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Strategy/Symbol Scanner panel">
            <ScannerPanel activeEnv={activeEnv} userLogin={userLogin} onPreviewTrade={onPreviewTrade} />
          </ErrorBoundary>
        </div>
      )}

      {/* 4. IV History Panel */}
      {visitedTabs.has("iv-history") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-iv-history"
          aria-labelledby="cap-tab-iv-history"
          hidden={hubTab !== "iv-history"}
          style={hubTab !== "iv-history" ? { display: "none" } : undefined}
        >
          <IvHistoryPanel />
        </div>
      )}

      {/* 5. Goal Screen Panel */}
      {visitedTabs.has("goal-screen") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-goal-screen"
          aria-labelledby="cap-tab-goal-screen"
          hidden={hubTab !== "goal-screen"}
          style={hubTab !== "goal-screen" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Goal Screen panel">
            <GoalScreenPanel activeEnv={activeEnv} userLogin={userLogin} />
          </ErrorBoundary>
        </div>
      )}

      {/* 6. Reports Panel */}
      {/* Issue #2884: Patterns catalog tab (?tab=screeners&view=patterns). */}
      {visitedTabs.has("patterns") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-patterns"
          aria-labelledby="cap-tab-patterns"
          hidden={hubTab !== "patterns"}
          style={hubTab !== "patterns" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Patterns panel">
            <PatternsPanel
              onApplyPattern={(filter, patternId) => {
                // Issue #2909 (G2): Apply fully determines the New
                // Screen panel — the pattern (id, pinned version,
                // filter, unmapped guardrails) rides as URL params
                // the StockHub decodes into its criteria, instead
                // of being dropped on navigation (audit F1).
                // Unknown ids fall back to the bare navigation,
                // never an invented pattern; preset storage is
                // never touched.
                const pattern = stockPatternById(patternId);
                navigateToTab(
                  "stock-hub",
                  "new-screen",
                  pattern ? buildAppliedPatternParams(pattern) : undefined,
                );
              }}
            />
          </ErrorBoundary>
        </div>
      )}

      {/* Issue #2886: Presets catalog tab (?tab=screeners&view=presets). */}
      {visitedTabs.has("presets") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-presets"
          aria-labelledby="cap-tab-presets"
          hidden={hubTab !== "presets"}
          style={hubTab !== "presets" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Presets panel">
            <PresetsPanel
              userLogin={userLogin}
              currentFilter={{}}
              onApplyPreset={() => navigateToTab("stock-hub", "new-screen")}
              onNavigateNewScreen={() => navigateToTab("stock-hub", "new-screen")}
            />
          </ErrorBoundary>
        </div>
      )}

      {visitedTabs.has("reports") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-reports"
          aria-labelledby="cap-tab-reports"
          hidden={hubTab !== "reports"}
          style={hubTab !== "reports" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Reports panel">
            <ReportsPanel />
          </ErrorBoundary>
        </div>
      )}

      {/* 7. Schedules Panel */}
      {visitedTabs.has("schedules") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-schedules"
          aria-labelledby="cap-tab-schedules"
          hidden={hubTab !== "schedules"}
          style={hubTab !== "schedules" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Schedules panel">
            <SchedulesPanel activeEnv={activeEnv} userLogin={userLogin} onPreviewTrade={onPreviewTrade} />
          </ErrorBoundary>
        </div>
      )}

      {/* 8. Proposal Review Panel */}
      {visitedTabs.has("review") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-review"
          aria-labelledby="cap-tab-review"
          hidden={hubTab !== "review"}
          style={hubTab !== "review" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Proposal Review panel">
            <ScreeningReviewPanel userLogin={userLogin} />
          </ErrorBoundary>
        </div>
      )}

      {/* 9. Track Record Panel */}
      {visitedTabs.has("track-record") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-track-record"
          aria-labelledby="cap-tab-track-record"
          hidden={hubTab !== "track-record"}
          style={hubTab !== "track-record" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Calibration dashboard">
            <CalibrationDashboard userLogin={userLogin} />
          </ErrorBoundary>
          {/* Issue #1888: enrichment dashboard panel — provider, coverage,
              breaker state, killswitch state, recent runs. */}
          <ErrorBoundary label="Enrichment dashboard">
            <EnrichmentDashboard userLogin={userLogin} />
          </ErrorBoundary>
          <ErrorBoundary label="Track Record panel">
            <ScreeningOutcomesPanel userLogin={userLogin} />
          </ErrorBoundary>
        </div>
      )}

      {/* 10. Multi-Asset Planned Panels (forex, futures, commodities, bonds) */}
      {(["forex", "futures", "commodities", "bonds"] as const).map((asset) =>
        visitedTabs.has(asset) ? (
          <div
            key={asset}
            role="tabpanel"
            id={`screener-tabpanel-${asset}`}
            aria-labelledby={`cap-tab-${asset}`}
            hidden={hubTab !== asset}
            style={hubTab !== asset ? { display: "none" } : undefined}
          >
            <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "var(--space-6)", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
              <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-muted)", fontSize: "var(--font-size-title-sm)" }}>
                🚧 {SCREENING_ASSET_CLASSES.find((a) => a.id === asset)?.label || "Asset"} Screener · Planned
              </h4>
              <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
                This instrument class is a planned extension point. Multi-asset provider adapters are currently in development.
              </p>
            </div>
          </div>
        ) : null
      )}

      <p className="options-assumptions">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </section>
  );
}
