import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, Select, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps } from "../searchTabTypes";

// Category filter options DERIVED from src/services/platformKnowledge.ts
// (the codes present in PLATFORM_WORKFLOWS_KNOWLEDGE + their labels).
// "payments" is in that file's category union type but has no entries,
// so it is deliberately not offered — never hardcode a second list.
const KNOWLEDGE_CATEGORIES: Array<{ code: string; label: string }> = [
  { code: "stocks", label: "Stocks" },
  { code: "options", label: "Options" },
  { code: "flows", label: "Flows" },
  { code: "brokerage", label: "Brokerage" },
  { code: "scheduled", label: "Automation" },
  { code: "nlq", label: "Chat & NLQ" },
];

interface KnowledgeResult {
  id: string;
  title: string;
  type: string;
  category: string;
  summary: string;
  details: string;
  howToUse: string[];
  targetTab: string;
  relevanceScore: number;
}

/**
 * Platform knowledge tab — POST /api/search/knowledge, platform mode
 * only (catalog directly, no AI blend, never mixed with agent chunks).
 * Scores shown are the catalog's native keyword relevance. Disclosure:
 * catalog results are keyword-matched platform content, not AI-index
 * results — the MCP surface expresses this convention as a hardcoded
 * score of 1.0 (commands.ts platformResultToChunks); this tab shows
 * the native relevance instead and says what it is.
 */
export function KnowledgeTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  // Issue #1169 S4-4: the last successful raw response, retained
  // verbatim for the Download button (native shape, no envelope).
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const lastNonce = useRef(0);

  async function run(q: string, cat: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    const started = Date.now();
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/search/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, category: cat === "all" ? undefined : cat }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "Knowledge search failed.");
      setResults(data.results || []);
      setLastResult(data);
      setSearched(true);
      const ms = Date.now() - started;
      setLatencyMs(ms);
      onHealth?.({
        status: (data.results || []).length > 0 ? "ok" : "empty",
        hits: (data.results || []).length,
        latencyMs: ms,
      });
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Knowledge search failed.");
      onHealth?.({ status: "error", hits: 0, latencyMs: Date.now() - started });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (pendingQuery && pendingQuery.nonce !== lastNonce.current) {
      lastNonce.current = pendingQuery.nonce;
      setQuery(pendingQuery.query);
      void run(pendingQuery.query, category);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery]);

  return (
    <div>
      <p>Platform knowledge — how the platform works, from the capability catalog (keyword-matched, not AI-index results).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query, category);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. how do I screen stocks" />
        <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {KNOWLEDGE_CATEGORIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" disabled={loading || !query.trim()} loading={loading}>
          {"Search"}
        </Button>
      </form>
      <Button type="button" onClick={() => downloadTextFile("knowledge-results.json", buildJson(lastResult), "application/json")} disabled={!lastResult} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {searched && (
        <div>
          <p>
            {results.length} results
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {results.map((r) => (
            <div key={r.id}>
              <p>
                <strong>{r.title}</strong> · {r.category} · relevance {r.relevanceScore}
              </p>
              <p>{r.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
