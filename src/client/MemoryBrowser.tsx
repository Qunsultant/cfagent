/**
 * Issue #164: VectorMemory browser — semantic search over the agent's
 * long-term memory of past outcomes.
 *
 * This is also the live-accumulation check: if searches return chunks,
 * vectors are landing in the index; an empty index means nothing has
 * been remembered yet.
 */
import React, { useCallback, useState } from "react";
import { searchMemory, type MemoryChunk } from "./memoryApi";
import { Button, TextInput } from "./components/ui";

export interface MemoryBrowserProps {
  embedded?: boolean;
}

export function MemoryBrowser({ embedded = false }: MemoryBrowserProps = {}) {
  const [query, setQuery] = useState("");
  const [operationFilter, setOperationFilter] = useState("");
  const [chunks, setChunks] = useState<MemoryChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError("");
    try {
      const { chunks } = await searchMemory(q, {
        operationFilter: operationFilter.trim() || undefined,
      });
      setChunks(chunks);
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory search failed.");
      setChunks([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [query, operationFilter, loading]);

  return (
    <div className={embedded ? "" : "memory-browser"}>
      <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: 12 }}>
        <TextInput
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          placeholder="Search past outcomes… (e.g. options strategy, payment failure)"
          style={{ flex: 1, padding: "var(--space-2) var(--space-3)" }}
        />
        <TextInput
          type="text"
          value={operationFilter}
          onChange={(e) => setOperationFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          placeholder="operation filter (optional)"
          style={{ width: 200, padding: "var(--space-2) var(--space-3)" }}
        />
        <Button onClick={() => void search()} disabled={loading || !query.trim()} loading={loading}>
          {"Search"}
        </Button>
      </div>

      {error && <div style={{ color: "var(--color-danger)", marginBottom: 12 }}>{error}</div>}

      {searched && !loading && !error && chunks.length === 0 && (
        <div style={{ opacity: 0.7 }}>
          No past outcomes matched. The memory index may still be accumulating —
          outcomes are stored after each chat turn completes.
        </div>
      )}

      {chunks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2-5)" }}>
          {chunks.map((c, i) => (
            <div
              key={`${c.operation}-${i}`}
              style={{
                border: "1px solid var(--color-border-medium)",
                borderRadius: 8,
                padding: "var(--space-2-5) var(--space-3)",
              }}
            >
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: 6 }}>
                <span
                  style={{
                    fontWeight: 700,
                    color: c.success ? "var(--color-success)" : "var(--color-danger)",
                  }}
                >
                  {c.success ? "OK" : "FAIL"}
                </span>
                <code style={{ fontSize: 12 }}>{c.operation}</code>
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.6 }}>
                  score {c.score.toFixed(3)}
                </span>
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{c.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
