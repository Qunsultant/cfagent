import React, { useState } from "react";
import { useUrlSyncedTabs } from "../useUrlSyncedTabs";
import { CapabilityNavBar, type CapabilityTabItem } from "../components/CapabilityNavBar";
import { ErrorBoundary } from "../ErrorBoundary";
import { PageShell } from "../components/ui";
import { Button, TextInput } from "../components/ui";
import type { PendingQuery, TabHealth } from "./searchTabTypes";
import { NlqSearchTab } from "./tabs/NlqSearchTab";
import { SearchAgentTab } from "./tabs/SearchAgentTab";
import { AiSearchAgentTab } from "./tabs/AiSearchAgentTab";
import { SearchMasTab } from "./tabs/SearchMasTab";
import { SemanticSearchTab } from "./tabs/SemanticSearchTab";
import { MemorySearchTab } from "./tabs/MemorySearchTab";
import { KnowledgeTab } from "./tabs/KnowledgeTab";
import { ToolSearchTab } from "./tabs/ToolSearchTab";
import { CorpusTab } from "./tabs/CorpusTab";

/**
 * Search hub (#2120 slice 1) — additive left-nav page, ScreenersHub
 * pattern: tab registry + isValid guard + useUrlSyncedTabs (param
 * "view", NO aliases — the hub has no legacy param) + CapabilityNavBar
 * + visited-tab retention (panels mount on first visit and stay in
 * the DOM, hidden when inactive) + per-tab ErrorBoundary.
 *
 * Each tab is its own result list — NEVER merged across tabs: result
 * shapes and provenance differ per system. The one deliberate
 * exception is the mas-search tab (#1169 S4-2): its value IS the
 * merge (scheduled reports + AI Search chunks in one list), and each
 * chunk is source-labeled so the merge stays visible. The hub adds only chrome:
 * a shared query ("Search all tabs" runs the query on every tab and
 * reports each tab's hit count in the health strip — the cross-tab
 * comparison of §5d-6), a health strip from already-returned error
 * shapes, and localStorage recent searches (client-local only, never
 * a system of record). No new telemetry, no new store.
 * The hub does NOT depend on KNOWLEDGE_SERVING_ENABLED.
 */
export const SEARCH_HUB_TABS = [
  "nlq",
  "search-agent",
  "ai-search-agent",
  "semantic-search",
  "memory",
  "knowledge",
  "tools",
  "mas-search",
  "corpus",
] as const;

export type SearchHubTab = (typeof SEARCH_HUB_TABS)[number];

export function isValidSearchHubTab(tab: unknown): tab is SearchHubTab {
  return typeof tab === "string" && (SEARCH_HUB_TABS as readonly string[]).includes(tab);
}

const TAB_META: Array<{ id: SearchHubTab; label: string; tooltip: string }> = [
  { id: "nlq", label: "NLQ", tooltip: "Records answers over POST /nlq" },
  { id: "search-agent", label: "Search Agent", tooltip: "AI Search instance results" },
  { id: "ai-search-agent", label: "AI Search Agent", tooltip: "The real AiSearchAgent over its Durable Object binding — namespace path, per-login report discipline" },
  { id: "semantic-search", label: "Semantic Search", tooltip: "Report search, Vectorize + lexical" },
  { id: "memory", label: "Memory", tooltip: "Agent memory (plans, outcomes)" },
  { id: "knowledge", label: "Knowledge", tooltip: "Platform capability catalog" },
  { id: "tools", label: "Tools", tooltip: "MCP tool + endpoint catalog" },
  { id: "mas-search", label: "MAS Search", tooltip: "Merged scheduled reports + AI Search results" },
  { id: "corpus", label: "Corpus", tooltip: "Corpus integrity, sync, and upload" },
];

const RECENT_KEY = "searchhub.recent";

interface RecentSearch {
  tab: SearchHubTab;
  query: string;
  at: string;
}

function loadRecent(): RecentSearch[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.query === "string" && isValidSearchHubTab(r.tab)) : [];
  } catch {
    return [];
  }
}

export function SearchHub() {
  const { activeTab: hubTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<SearchHubTab>({
    param: "view",
    isValid: isValidSearchHubTab,
    defaultTab: "nlq",
  });
  const [sharedQuery, setSharedQuery] = useState("");
  const [pendingQuery, setPendingQuery] = useState<PendingQuery | null>(null);
  const [runAll, setRunAll] = useState(false);
  const [health, setHealth] = useState<Partial<Record<SearchHubTab, TabHealth>>>({});
  const [recent, setRecent] = useState<RecentSearch[]>(() => loadRecent());

  const tabs: CapabilityTabItem[] = TAB_META.map((t) => ({
    id: t.id,
    label: t.label,
    tooltip: { title: t.label, description: t.tooltip },
  }));

  function recordRecent(tab: SearchHubTab, query: string) {
    setRecent((prev) => {
      const next = [{ tab, query, at: new Date().toISOString() }, ...prev.filter((r) => !(r.tab === tab && r.query === query))].slice(0, 20);
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Client-local only; a storage failure must never break search.
      }
      return next;
    });
  }

  function renderTab(tab: SearchHubTab) {
    const props = {
      pendingQuery,
      onHealth: (h: TabHealth) => setHealth((prev) => ({ ...prev, [tab]: h })),
      onSearch: (q: string) => recordRecent(tab, q),
    };
    switch (tab) {
      case "nlq":
        return <NlqSearchTab {...props} />;
      case "search-agent":
        return <SearchAgentTab {...props} />;
      case "ai-search-agent":
        return <AiSearchAgentTab {...props} />;
      case "semantic-search":
        return <SemanticSearchTab {...props} />;
      case "memory":
        return <MemorySearchTab {...props} />;
      case "knowledge":
        return <KnowledgeTab {...props} />;
      case "tools":
        return <ToolSearchTab {...props} />;
      case "mas-search":
        return <SearchMasTab {...props} />;
      case "corpus":
        return <CorpusTab {...props} />;
    }
  }

  const mounted = new Set<SearchHubTab>(visitedTabs);
  if (runAll) {
    for (const t of SEARCH_HUB_TABS) mounted.add(t);
  }

  return (
    <PageShell title="Search" scopeNote="One search hub: NLQ records, AI search agent, semantic report search, agent memory, platform knowledge, and tool catalog. Each tab is its own system — results are never merged across tabs.">
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "1rem" }}>
        <div style={{ flex: "1 1 16rem" }}>
          <TextInput label="Search all tabs" value={sharedQuery} onChange={(e) => setSharedQuery(e.target.value)} placeholder="Run one query on every tab" />
        </div>
        <Button
          variant="primary"
          disabled={!sharedQuery.trim()}
          onClick={() => {
            setRunAll(true);
            setPendingQuery({ query: sharedQuery.trim(), nonce: Date.now() });
          }}
        >
          Search all tabs
        </Button>
      </div>

      <div aria-label="Search hub health" style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap", marginBottom: "1rem", fontSize: "var(--font-size-body)" }}>
        {TAB_META.map((t) => {
          const h = health[t.id];
          return (
            <span key={t.id}>
              {t.label}: {h ? `${h.status} · ${h.hits} hits · ${h.latencyMs} ms` : "not run"}
            </span>
          );
        })}
      </div>

      {recent.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <span>Recent searches: </span>
          {recent.slice(0, 10).map((r, i) => (
            <Button
              key={i}
              variant="ghost"
              onClick={() => {
                handleTabChange(r.tab);
                setPendingQuery({ query: r.query, nonce: Date.now() });
              }}
            >
              {r.query} ({r.tab})
            </Button>
          ))}
        </div>
      )}

      <CapabilityNavBar ariaLabel="Search capabilities" tabs={tabs} activeTabId={hubTab} onTabChange={handleTabChange} />

      {SEARCH_HUB_TABS.map(
        (tab) =>
          mounted.has(tab) && (
            <div
              key={tab}
              role="tabpanel"
              id={`search-tabpanel-${tab}`}
              aria-labelledby={`cap-tab-${tab}`}
              hidden={hubTab !== tab}
              style={hubTab !== tab ? { display: "none" } : undefined}
            >
              <ErrorBoundary label={`Search ${tab}`}>{renderTab(tab)}</ErrorBoundary>
            </div>
          )
      )}
    </PageShell>
  );
}
