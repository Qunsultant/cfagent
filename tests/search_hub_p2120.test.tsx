/** @vitest-environment jsdom */
/**
 * #2120 slice 1: Search hub pins.
 * Additive only: the hub adds a left-nav Search page reusing existing
 * backends. Nothing below asserts behavior of the pre-existing surfaces
 * beyond "still present and rendering" — their internals are untouched.
 *
 * Red honesty: on the pristine tree, the nav/source pins fail at
 * ASSERTION (no `search` entry/key exists yet) and the component pins
 * fail at COLLECTION (SearchHub + tabs + route module do not exist).
 * A collection-failed file is an unrun file, not a passing one.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { SearchHub, SEARCH_HUB_TABS, isValidSearchHubTab } from "../src/client/search/SearchHub";
import { NlqSearchTab } from "../src/client/search/tabs/NlqSearchTab";
import { SearchAgentTab } from "../src/client/search/tabs/SearchAgentTab";
import { SemanticSearchTab } from "../src/client/search/tabs/SemanticSearchTab";
import { MemorySearchTab } from "../src/client/search/tabs/MemorySearchTab";
import { KnowledgeTab } from "../src/client/search/tabs/KnowledgeTab";
import { ToolSearchTab } from "../src/client/search/tabs/ToolSearchTab";
import { ReportsPanel } from "../src/client/ReportsPanel";
import { MemoryBrowser } from "../src/client/MemoryBrowser";
import { McpApiExplorer } from "../src/client/McpApiExplorer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await flush();
}

function text() {
  return container.textContent || "";
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitForm() {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function stubFetch(handler: (url: string, init?: any) => any) {
  const calls: Array<{ url: string; init?: any }> = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

const okJson = (body: any) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

describe("#2120 slice 1 nav registration (source pins)", () => {
  it("ROUTES has the search entry with the designed shape", () => {
    const routes = src("client/routes.ts");
    expect(routes).toContain('id: "search"');
    const start = routes.indexOf('id: "search"');
    const block = routes.slice(start, start + 600);
    expect(block).toContain('category: "Intelligence"');
    expect(block).toContain('icon: "Search"');
    expect(block).toContain("navOrder: 9");
    expect(block).toContain("defaultVisible: true");
  });

  it("TAB_CONTENT has the search key", () => {
    const chat = src("client/Chat.tsx");
    // Line-anchored: a substring check would false-positive on
    // "research: (" (which contains "search: (").
    expect(chat).toContain("<SearchHub />");
    expect(chat.split("\n").some((l) => l.trim() === "search: (")).toBe(true);
  });

  it("pre-hub ROUTES ids are all still present (superset)", () => {
    const routes = src("client/routes.ts");
    for (const id of ["nlq", "screeners", "social", "docs", "chat", "endpoints", "audit", "payments", "referrals", "research", "revenue", "workflows"]) {
      expect(routes).toContain(`id: "${id}"`);
    }
  });

  it("pre-hub TAB_CONTENT keys are all still present (superset)", () => {
    const chat = src("client/Chat.tsx");
    // #2149: payments/social left TAB_CONTENT for SHELL_CONTENT, and
    // #2161: ads/referrals/revenue followed — the superset holds for
    // the remaining keys; the shell keys pin below.
    for (const key of ["audit:", "chat:", "docs:", "endpoints:", "nlq:", "research:", "workflows:"]) {
      expect(chat).toContain(`    ${key} (`);
    }
  });

  it("pre-hub shell pages are still present (SHELL_CONTENT, #2149, #2161)", () => {
    const chat = src("client/Chat.tsx");
    expect(chat).toContain("    payments: <PaymentsPage");
    expect(chat).toContain("    social: <SocialPostingPanel");
    expect(chat).toContain("    ads: (");
    expect(chat).toContain("    referrals: (");
    expect(chat).toContain("    revenue: (");
  });

  it("Chat NLQ view is unchanged (still pending-prompt submit)", () => {
    const chat = src("client/Chat.tsx");
    expect(chat).toContain("nlq-view");
    expect(chat).toContain('setPendingPrompt({ prompt: nlqInput.trim(), sourceTab: "Records Explorer" })');
  });
});

describe("#2120 slice 1 hub chrome", () => {
  it("tab registry has exactly the eight designed tabs", () => {
    // #1169 S4-2 (disclosed §7 pin update): the MAS search tab joins
    // the registry; the six prior tabs are unchanged and in order.
    // #1169 knowledge UI (disclosed §7 pin update): the Corpus tab
    // joins the registry last; all prior tabs unchanged and in order.
    expect([...SEARCH_HUB_TABS]).toEqual([
      "nlq",
      "search-agent",
      "semantic-search",
      "memory",
      "knowledge",
      "tools",
      "mas-search",
      "corpus",
    ]);
    expect(isValidSearchHubTab("memory")).toBe(true);
    expect(isValidSearchHubTab("corpus")).toBe(true);
    expect(isValidSearchHubTab("bogus")).toBe(false);
  });

  it("renders all eight tab labels and defaults to nlq", async () => {
    window.history.pushState(null, "", "/?tab=search");
    await render(<SearchHub />);
    // #1169 S4-2 (disclosed §7 pin update): "MAS Search" joins the labels.
    // #1169 knowledge UI (disclosed §7 pin update): "Corpus" joins.
    for (const label of ["NLQ", "Search Agent", "Semantic Search", "Memory", "Knowledge", "Tools", "MAS Search", "Corpus"]) {
      expect(text()).toContain(label);
    }
    expect(text()).toContain("NLQ records search");
  });

  it("?view=memory lands on the memory tab", async () => {
    window.history.pushState(null, "", "/?tab=search&view=memory");
    await render(<SearchHub />);
    expect(text()).toContain("Agent memory search");
  });

  it("unknown ?view= falls back to the default nlq tab", async () => {
    window.history.pushState(null, "", "/?tab=search&view=bogus");
    await render(<SearchHub />);
    expect(text()).toContain("NLQ records search");
  });
});

describe("#2120 slice 1 tab backends (native shapes)", () => {
  it("NLQ tab posts to /api/nlq and renders summary + count + rows", async () => {
    const calls = stubFetch((url) => {
      if (url === "/api/nlq") {
        return okJson({
          plan: { operation: "query" },
          count: 2,
          domain: "records",
          summary: "Two matching rows",
          rows: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
          executedAt: "2026-10-28T00:00:00Z",
        });
      }
      return okJson({});
    });
    await render(<NlqSearchTab />);
    setInputValue(container.querySelector("input")!, "show my records");
    await submitForm();
    expect(calls.some((c) => c.url === "/api/nlq")).toBe(true);
    const body = JSON.parse(calls.find((c) => c.url === "/api/nlq")!.init.body);
    expect(body.query).toBe("show my records");
    expect(text()).toContain("Two matching rows");
    expect(text()).toContain("2 results");
    expect(text()).toContain("AAPL");
  });

  it("agent tab posts to /api/search/agent and shows provider honestly", async () => {
    stubFetch((url) => {
      if (url === "/api/search/agent") {
        return okJson({
          query: "options risk",
          results: [
            {
              title: "OCC disclosure",
              snippet: "Options involve risk",
              url: "https://example.invalid/occ",
              score: 0.9,
              category: "options_disclosure",
            },
          ],
          totalMatches: 1,
          provider: "semantic_cache",
          timestamp: "2026-10-28T00:00:00Z",
        });
      }
      return okJson({});
    });
    await render(<SearchAgentTab />);
    setInputValue(container.querySelector("input")!, "options risk");
    await submitForm();
    expect(text()).toContain("OCC disclosure");
    expect(text()).toContain("semantic_cache");
  });

  it("semantic tab hydrates hits via /api/reports and shows semantic bool", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/reports/semantic-search")) {
        return okJson({
          hits: [{ reportId: "r1", rank: 0.9, via: "semantic" }],
          semantic: true,
        });
      }
      if (url.startsWith("/api/reports")) {
        return okJson({ reports: [{ id: "r1", title: "Weekly report" }] });
      }
      return okJson({});
    });
    await render(<SemanticSearchTab />);
    setInputValue(container.querySelector("input")!, "weekly");
    await submitForm();
    expect(text()).toContain("Weekly report");
    expect(text()).toContain("semantic: true");
  });

  it("memory tab searches via searchMemory and renders chunks natively", async () => {
    stubFetch((url) => {
      if (url === "/api/memory/search") {
        return okJson({
          chunks: [{ summary: "Plan recalled", operation: "plan", success: true, score: 0.8 }],
        });
      }
      return okJson({});
    });
    await render(<MemorySearchTab />);
    setInputValue(container.querySelector("input")!, "plan");
    await submitForm();
    expect(text()).toContain("Plan recalled");
    expect(text()).toContain("plan");
  });

  it("knowledge tab posts to /api/search/knowledge and discloses catalog scoring", async () => {
    stubFetch((url) => {
      if (url === "/api/search/knowledge") {
        return okJson({
          query: "screener",
          count: 1,
          results: [
            {
              id: "k1",
              title: "Stock screener",
              type: "capability",
              category: "Stocks",
              summary: "Screen stocks",
              details: "Details",
              howToUse: ["Open screeners"],
              targetTab: "screeners",
              relevanceScore: 42,
            },
          ],
          formattedAnswer: "",
        });
      }
      return okJson({});
    });
    await render(<KnowledgeTab />);
    setInputValue(container.querySelector("input")!, "screener");
    await submitForm();
    expect(text()).toContain("Stock screener");
    expect(text()).toContain("42");
    expect(text()).toContain("keyword-matched");
  });

  it("tools tab filters the client catalog with no network", async () => {
    const calls = stubFetch(() => okJson({}));
    await render(<ToolSearchTab />);
    // knowledge_search is in the client catalog (mcpEndpointsData.ts);
    // ai_search_financial_docs is NOT (it lives in cloudflareAgentCommands
    // only) — the tab covers the catalog, and the pin asserts a member.
    setInputValue(container.querySelector("input")!, "knowledge_search");
    await submitForm();
    expect(calls.length).toBe(0);
    expect(text()).toContain("knowledge_search");
  });
});

describe("#2120 slice 1 existing surfaces still render", () => {
  it("ReportsPanel, MemoryBrowser, McpApiExplorer render without throwing", async () => {
    stubFetch(() => okJson({ reports: [], runs: [], chunks: [] }));
    await render(<ReportsPanel />);
    expect(text().length).toBeGreaterThan(0);
  });

  it("MemoryBrowser renders", async () => {
    stubFetch(() => okJson({ chunks: [] }));
    await render(<MemoryBrowser />);
    expect(text().length).toBeGreaterThan(0);
  });

  it("McpApiExplorer renders", async () => {
    stubFetch(() => okJson({}));
    await render(<McpApiExplorer />);
    expect(text()).toContain("MCP");
  });
});
