import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps } from "../searchTabTypes";

interface HybridHit {
  reportId: string;
  rank: number;
  via: string;
}

/**
 * Semantic report search — GET /api/reports/semantic-search (Vectorize +
 * lexical hybrid, native {hits, semantic} shape) with /api/reports
 * hydration, mirroring ReportsPanel's pattern (not the panel itself).
 * `semantic: bool` is rendered honestly: false means lexical-only.
 */
export function SemanticSearchTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HybridHit[]>([]);
  // Issue #1169 S4-4: the last successful raw semantic-search
  // response, retained verbatim for the Download button (native
  // {hits, semantic} shape; the hydrated titles are display-only
  // and are not part of the download).
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [semantic, setSemantic] = useState<boolean | null>(null);
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
    try {
      const params = new URLSearchParams({ q: trimmed });
      const res = await apiFetch(`/api/reports/semantic-search?${params}`);
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found: HybridHit[] = data.hits || [];
      setHits(found);
      setLastResult(data);
      setSemantic(data.semantic === true);
      const ids = found.map((h) => h.reportId);
      if (ids.length > 0) {
        const all = await apiFetch("/api/reports?limit=100").then((r) => r.json()) as any;
        const byId: Record<string, string> = {};
        for (const r of all.reports || []) byId[String(r.id)] = r.title || String(r.id);
        setTitles(byId);
      } else {
        setTitles({});
      }
      const ms = Date.now() - started;
      setLatencyMs(ms);
      onHealth?.({ status: found.length > 0 ? "ok" : "empty", hits: found.length, latencyMs: ms });
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Semantic search failed.");
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
      <p>Semantic report search — reports searched semantically (Vectorize) merged with lexical matches.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. weekly options" />
        <Button type="submit" variant="primary" disabled={loading || !query.trim()} loading={loading}>
          {"Search"}
        </Button>
      </form>
      <Button type="button" onClick={() => downloadTextFile("semantic-search-results.json", buildJson(lastResult), "application/json")} disabled={!lastResult} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {semantic !== null && (
        <div>
          <p>
            {hits.length} hits · semantic: {semantic ? "true" : "false"}
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {!semantic && <p>Lexical-only: the semantic index returned no vector hits for this query.</p>}
          {hits.map((h) => (
            <p key={h.reportId}>
              {titles[h.reportId] || h.reportId} · via {h.via} · rank {h.rank}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
