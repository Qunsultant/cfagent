/** @vitest-environment jsdom */
/**
 * Template organisms II (#3133, Part of #2150): CardHeader, WorkCard,
 * DetailCard — the card layer the beautiful pages hand-roll today
 * (order form card, autopilot chart card, risk-panel headers),
 * rebuilt as primitives with token-only styling.
 *
 * Each organism reproduces its hand-rolled original's structure and
 * tone (verified against OrderTicketPanel.tsx:370-403,
 * AutopilotControlCenter.tsx:818-829, and RiskAnalysisPanel.tsx:70):
 * same children in the same order, same distributed header (title
 * left, meta right), same card surface. Deliberate deltas, all
 * required by the primitive system: the surfaces are the formalized
 * Card (pad-md 1.25rem, 12px radius — the form card's var(--radius-lg))
 * where the hand-rolled cards used bespoke 1.5rem padding (order form)
 * and 1.25rem/1.35rem padding (chart card); WorkCard is flat where the
 * order form had no shadow, DetailCard is elevated where the chart card
 * had the e2 shadow; no outer margin on any organism (spacing is the
 * parent Stack's gap, §1.6b). No page migrates in this slice (Wave 1,
 * #3138–#3140), so nothing visual changes anywhere. SummaryCard
 * (#3132) keeps its own header — it is not refactored here.
 *
 * Rule of three: work/summary/detail are THE card treatments, no
 * fourth — pinned below against the ui barrel.
 *
 * Mapping notes (Wave 1 consumers — bespoke *-card-header classes
 * found across src/client, each its own header treatment today):
 * - WorkCard: order form card (OrderTicketPanel.tsx:370, header :371
 *   .card-header-styled); risk-analysis form card (the order-workspace
 *   pattern, RiskAnalysisPanel.tsx).
 * - DetailCard: autopilot chart card (AutopilotControlCenter.tsx:818,
 *   .chart-card-header :819); autopilot status/limits/actions cards
 *   (AutopilotControlCenter.tsx: .status-card-header,
 *   .limits-card-header, .actions-card-header); HITL card
 *   (ETradeTradingHub.tsx: .hitl-card-header); omnichannel card
 *   (OmnichannelPanel.tsx: .omnichannel-card-header); deal card
 *   (PartnerDealsModal.tsx: .deal-card-header); options strategy card
 *   (chat/OptionsStrategyCard.tsx: .options-card-header); tool result
 *   card (chat/ToolResultView.tsx: .tool-card-header); browsed card
 *   (Chat.tsx: .browsed-card-header); research cards
 *   (MarketDataResearchHub.tsx: .section-intro-card-header,
 *   .dual-feed-card-header, .quote-card-header); workflow cards
 *   (WorkflowsHub.tsx: .faq-card-header, .workflow-card-header);
 *   chat error card (chat/AgentChatTabContent.tsx:
 *   .chat-error-card-header).
 * - CardHeader (direct): the panel-local CardHeader
 *   (RiskAnalysisPanel.tsx:70) is the first candidate to be replaced
 *   by the primitive import — same contract (title + optional meta).
 *
 * Rendered through React, same harness as template_organisms_3132.test.tsx.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as uiBarrel from "../src/client/components/ui";
import { CardHeader } from "../src/client/components/ui/CardHeader";
import { WorkCard } from "../src/client/components/ui/WorkCard";
import { DetailCard } from "../src/client/components/ui/DetailCard";
import { PageTemplate } from "../src/client/components/ui/PageTemplate";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
}

afterEach(() => {
  if (root) root.unmount();
  root = undefined as any;
  container?.remove();
});

describe("CardHeader (#3133 — distributed header, OrderTicketPanel.tsx:371 + RiskAnalysisPanel.tsx:70)", () => {
  it("renders title left, subtitle under it, meta right", () => {
    render(
      <CardHeader
        title="⚡ Options Order Ticket"
        subtitle="Broker-priced options strategy preview with human approval required"
        meta={<span>Refresh Quote</span>}
      />,
    );
    expect(document.querySelector(".ui-card-header")).not.toBeNull();
    const title = document.querySelector(".ui-card-header h4");
    expect(title?.textContent).toBe("⚡ Options Order Ticket");
    expect(document.querySelector(".ui-card-header-subtitle")?.textContent).toContain(
      "Broker-priced options strategy preview",
    );
    // Meta is pushed right with .ui-push, and reads after the title.
    const meta = document.querySelector(".ui-card-header .ui-push");
    expect(meta?.textContent).toBe("Refresh Quote");
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Options Order Ticket")).toBeLessThan(text.indexOf("Refresh Quote"));
  });

  it("renders below-subtitle content under the subtitle (order form badge row)", () => {
    render(
      <CardHeader
        title="⚡ Options Order Ticket"
        subtitle="Broker-priced options strategy preview with human approval required"
        belowSubtitle={<span>Broker: E*TRADE · Paper</span>}
        meta={<span>Refresh Quote</span>}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Broker-priced")).toBeLessThan(text.indexOf("Broker: E*TRADE"));
    expect(text.indexOf("Broker: E*TRADE")).toBeLessThan(text.indexOf("Refresh Quote"));
  });

  it("meta-only header still reads right (chart card's timeframe pills, AutopilotControlCenter.tsx:819)", () => {
    render(<CardHeader meta={<span>1D 1W 1M</span>} />);
    expect(document.querySelector(".ui-card-header h4")).toBeNull();
    expect(document.querySelector(".ui-card-header .ui-push")?.textContent).toBe("1D 1W 1M");
  });

  it("renders nothing when there is nothing to show (slot rule, §1.6b)", () => {
    render(<CardHeader />);
    expect(document.querySelector(".ui-card-header")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
});

describe("WorkCard (#3133 — order form card, OrderTicketPanel.tsx:370)", () => {
  it("renders a flat card with the header and the input flow", () => {
    render(
      <WorkCard
        title="⚡ Options Order Ticket"
        subtitle="Broker-priced options strategy preview with human approval required"
        meta={<span>Refresh Quote</span>}
      >
        <div>order form fields</div>
      </WorkCard>,
    );
    const card = document.querySelector(".ui-card");
    expect(card).not.toBeNull();
    expect(card?.classList.contains("elevated")).toBe(false);
    expect(document.querySelector(".ui-card-header h4")?.textContent).toBe(
      "⚡ Options Order Ticket",
    );
    expect(document.body.textContent).toContain("order form fields");
    // The form card's 1.25rem column rhythm (Stack gap 5).
    expect(document.querySelector(".ui-card .ui-stack.gap-5")).not.toBeNull();
  });

  it("renders without header props — a card with only its input flow", () => {
    render(
      <WorkCard>
        <div>order form fields</div>
      </WorkCard>,
    );
    expect(document.querySelector(".ui-card")).not.toBeNull();
    expect(document.querySelector(".ui-card-header")).toBeNull();
    expect(document.body.textContent).toContain("order form fields");
  });
});

describe("DetailCard (#3133 — autopilot chart card, AutopilotControlCenter.tsx:818)", () => {
  it("renders an elevated card with the header and the content block", () => {
    render(
      <DetailCard title="Strategy Equity vs S&P 500 Benchmark" meta={<span>1D 1W 1M</span>}>
        <div>equity chart</div>
      </DetailCard>,
    );
    const card = document.querySelector(".ui-card.elevated");
    expect(card).not.toBeNull();
    expect(document.querySelector(".ui-card-header h4")?.textContent).toBe(
      "Strategy Equity vs S&P 500 Benchmark",
    );
    expect(document.body.textContent).toContain("equity chart");
    // The chart card's 1rem header rhythm (Stack gap 4).
    expect(document.querySelector(".ui-card .ui-stack.gap-4")).not.toBeNull();
  });

  it("renders a meta-only header — the chart card's title lives in the PageSection above it", () => {
    render(
      <DetailCard meta={<span>1D 1W 1M</span>}>
        <div>equity chart</div>
      </DetailCard>,
    );
    expect(document.querySelector(".ui-card.elevated")).not.toBeNull();
    expect(document.querySelector(".ui-card-header h4")).toBeNull();
    expect(document.querySelector(".ui-card-header .ui-push")?.textContent).toBe("1D 1W 1M");
    expect(document.body.textContent).toContain("equity chart");
  });
});

describe("rule of three: work/summary/detail are the card treatments, no fourth (#3133)", () => {
  it("the ui barrel exports exactly three card treatments plus the shared Card surface", () => {
    const cardNames = Object.keys(uiBarrel)
      .filter((name) => name.endsWith("Card"))
      .sort();
    expect(cardNames).toEqual(["Card", "DetailCard", "SummaryCard", "WorkCard"]);
  });
});

describe("cards drop into PageTemplate workspace in order", () => {
  it("work card, then detail card — no new chrome", () => {
    render(
      <PageTemplate title="T">
        <WorkCard title="Work">
          <div>input flow</div>
        </WorkCard>
        <DetailCard title="Detail">
          <div>content block</div>
        </DetailCard>
      </PageTemplate>,
    );
    const text = document.body.textContent ?? "";
    expect(text.indexOf("input flow")).toBeGreaterThan(-1);
    expect(text.indexOf("content block")).toBeGreaterThan(text.indexOf("input flow"));
  });
});
