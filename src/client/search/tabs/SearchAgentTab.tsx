import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, Notice, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps } from "../searchTabTypes";

interface AgentResult {
  title?: string;
  snippet?: string;
  url?: string;
  score?: number;
  category?: string;
  bucketKey?: string;
  servedFileLink?: string;
}

/**
 * Search-agent tab — AI Search instance results via POST /api/search/agent
 * (service-native AISearchQueryResponse). `provider` is rendered honestly
 * per result set. Since issue #1169 S3 the service has no fallback corpus:
 * when the live index does not serve, the response carries a `degraded`
 * reason and zero results, and this tab shows that as a visible warning
 * notice — never as silent emptiness or substitute rows. A served empty
 * answer (no `degraded`) renders as a plain zero-results state. Chunks
 * without a bucketKey get no served-file link: the non-corpus rendering
 * gap is displayed by omission, never papered over with a placeholder
 * link.
 */
export function SearchAgentTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AgentResult[]>([]);
  // Issue #1169 S4-4: the last successful raw response, retained
  // verbatim for the Download button (native shape, no envelope).
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [provider, setProvider] = useState("");
  // Issue #1169 (S3): the service's in-band degraded reason, when the
  // live index did not serve the last query ("" = served normally).
  const [degraded, setDegraded] = useState("");
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const lastNonce = useRef(0);

  async function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    const started = Date.now();
    setLoading(true);
    setError("");
    setDegraded("");
    try {
      const res = await apiFetch("/api/search/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "Agent search failed.");
      setResults(data.results || []);
      setLastResult(data);
      setProvider(data.provider || "");
      setDegraded(typeof data.degraded === "string" ? data.degraded : "");
      setSearched(true);
      const ms = Date.now() - started;
      setLatencyMs(ms);
      onHealth?.({
        status: data.degraded ? "error" : (data.results || []).length > 0 ? "ok" : "empty",
        hits: (data.results || []).length,
        latencyMs: ms,
      });
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent search failed.");
      onHealth?.({ status: "error", hits: 0, latencyMs: Date.now() - started });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (pendingQuery && pendingQuery.nonce !== lastNonce.current) {
      lastNonce.current = pendingQuery.nonce;
      setQuery(pendingQuery.query);
      void run(pendingQuery.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery]);

  return (
    <div>
      <p>Search Agent — financial documents from the AI Search instance (MCP tool ai_search_financial_docs, now with a UI).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. options risk disclosure" />
        <Button type="submit" variant="primary" disabled={loading || !query.trim()} loading={loading}>
          {"Search"}
        </Button>
      </form>
      <Button type="button" onClick={() => downloadTextFile("search-agent-results.json", buildJson(lastResult), "application/json")} disabled={!lastResult} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {searched && (
        <div>
          <p>
            {results.length} results · provider: {provider}
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {degraded && (
            <Notice tone="warning" title="Live index unavailable">
              The AI Search instance did not serve this query (degraded: {degraded}). No substitute results are shown — the built-in fallback corpus was removed (issue 1169, S3).
            </Notice>
          )}
          {results.map((r, i) => (
            <div key={i}>
              <p>
                <strong>{r.title || "Untitled"}</strong>
                {r.score !== undefined ? ` · score ${r.score}` : ""}
                {r.category ? ` · ${r.category}` : ""}
              </p>
              {r.snippet && <p>{r.snippet}</p>}
              {r.servedFileLink && (
                <p>
                  <a href={r.servedFileLink}>Served file</a>
                  {r.bucketKey ? ` · ${r.bucketKey}` : ""}
                </p>
              )}
              {r.url && !r.servedFileLink && (
                <p>
                  <a href={r.url}>{r.url}</a>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
