import React, { useEffect, useRef, useState } from "react";
import { Button, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import { searchMemory, type MemoryChunk } from "../../memoryApi";
import type { SearchTabProps } from "../searchTabTypes";

/** Agent memory search — thin wrapper over the existing searchMemory contract (POST /api/memory/search). */
export function MemorySearchTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [chunks, setChunks] = useState<MemoryChunk[]>([]);
  // Issue #1169 S4-4: the last successful raw memoryApi result,
  // retained verbatim for the Download button (native shape).
  const [lastResult, setLastResult] = useState<unknown>(null);
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
    try {
      const memResult = await searchMemory(trimmed, { topK: 10 });
      const found = memResult.chunks;
      setChunks(found);
      setLastResult(memResult);
      setSearched(true);
      const ms = Date.now() - started;
      setLatencyMs(ms);
      onHealth?.({ status: found.length > 0 ? "ok" : "empty", hits: found.length, latencyMs: ms });
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memory search failed.");
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
      <p>Agent memory search — plans and outcomes from agent memory (Vectorize, kind plan/outcome — not report vectors).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. last plan" />
        <Button type="submit" variant="primary" disabled={loading || !query.trim()} loading={loading}>
          {"Search"}
        </Button>
      </form>
      <Button type="button" onClick={() => downloadTextFile("memory-search-results.json", buildJson(lastResult), "application/json")} disabled={!lastResult} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {searched && (
        <div>
          <p>
            {chunks.length} results
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {chunks.map((c, i) => (
            <p key={i}>
              {c.summary} · {c.operation} · {c.success ? "success" : "failed"} · score {c.score}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
