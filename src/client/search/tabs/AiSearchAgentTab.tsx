import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, Notice, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps } from "../searchTabTypes";

interface AiAgentResult {
  title?: string;
  snippet?: string;
  source?: string;
  score?: number;
  category?: string;
  bucketKey?: string;
  servedFileLink?: string;
  indexingState?: string;
}

/**
 * AI Search Agent tab (issue #3323) — the Search hub's surface onto
 * the REAL AiSearchAgent, via POST /api/search/ai-agent. Unlike the
 * "Search Agent" tab (which calls ETradeAISearchService directly),
 * this route dispatches to the AiSearchAgent over its Durable
 * Object binding: the agent searches the instance namespace-first,
 * then MCP, then REST, and the answer is labelled with the path
 * that served it. The route threads the session login into the
 * search, so report-type results are served only to their owner.
 *
 * Honesty, mirroring the sibling tab: an answer the agent did not
 * serve (ok:false — e.g. the binding is not configured) renders as
 * a visible warning with the agent's code and error verbatim,
 * never as silent emptiness or substitute rows; a served-but-
 * degraded answer shows the agent's degraded note verbatim above
 * the results it did serve. Chunk metadata (bucketKey /
 * servedFileLink / indexingState provenance) renders exactly as
 * the agent returned it — nothing is re-mapped or invented here.
 */
export function AiSearchAgentTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AiAgentResult[]>([]);
  // The last raw response, retained verbatim for the Download
  // button (native shape, no envelope) — the sibling tabs' S4-4
  // pattern.
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [path, setPath] = useState("");
  const [degraded, setDegraded] = useState("");
  // The agent's failure state when it did not serve (ok:false):
  // its stable code + human-readable error, rendered verbatim.
  const [failure, setFailure] = useState<{ code?: string; error?: string } | null>(null);
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
    setFailure(null);
    try {
      const res = await apiFetch("/api/search/ai-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "AI Search Agent search failed.");
      setResults(data.results || []);
      setLastResult(data);
      setPath(data.path || "");
      setDegraded(typeof data.degraded === "string" ? data.degraded : "");
      setFailure(data.ok ? null : { code: data.code, error: data.error });
      setSearched(true);
      const ms = Date.now() - started;
      setLatencyMs(ms);
      onHealth?.({
        status: !data.ok || data.degraded ? "error" : (data.results || []).length > 0 ? "ok" : "empty",
        hits: (data.results || []).length,
        latencyMs: ms,
      });
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI Search Agent search failed.");
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
      <p>
        AI Search Agent — the real AiSearchAgent (a Durable Object) searches the AI Search instance over its namespace binding
        (namespace path first, then MCP, then REST). Your session login is threaded into the search, so generated-report results
        are served only to their owner.
      </p>
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
      <Button type="button" onClick={() => downloadTextFile("ai-search-agent-results.json", buildJson(lastResult), "application/json")} disabled={!lastResult} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {searched && (
        <div>
          <p>
            {results.length} results · path: {path || "none"}
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {failure && (
            <Notice tone="warning" title="AiSearchAgent did not serve live results">
              The agent returned no live results{failure.code ? ` (${failure.code})` : ""}: {failure.error || "unknown error"}. No
              substitute results are shown.
            </Notice>
          )}
          {!failure && degraded && (
            <Notice tone="warning" title="Degraded answer">
              The agent served this answer in a degraded state: {degraded}
            </Notice>
          )}
          {results.map((r, i) => (
            <div key={i}>
              <p>
                <strong>{r.title || "Untitled"}</strong>
                {r.score !== undefined ? ` · score ${r.score}` : ""}
                {r.category ? ` · ${r.category}` : ""}
                {r.indexingState ? ` · indexing: ${r.indexingState}` : ""}
              </p>
              {r.snippet && <p>{r.snippet}</p>}
              {r.servedFileLink && (
                <p>
                  <a href={r.servedFileLink}>Served file</a>
                  {r.bucketKey ? ` · ${r.bucketKey}` : ""}
                </p>
              )}
              {r.source && !r.servedFileLink && (/^https?:\/\//.test(r.source) ? (
                <p>
                  <a href={r.source}>{r.source}</a>
                </p>
              ) : (
                <p>{r.source}</p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
