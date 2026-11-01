import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps, TabHealth } from "../searchTabTypes";

interface NlqResult {
  summary?: string;
  count?: number;
  domain?: string;
  rows?: Array<Record<string, unknown>>;
}

/** NLQ records search — answers about records over POST /api/nlq (native NLQQueryResult shape). */
export function NlqSearchTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<NlqResult | null>(null);
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
      const res = await apiFetch("/api/nlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "NLQ search failed.");
      setResult(data as NlqResult);
      const ms = Date.now() - started;
      setLatencyMs(ms);
      const health: TabHealth = {
        status: (data.count ?? 0) > 0 ? "ok" : "empty",
        hits: data.count ?? 0,
        latencyMs: ms,
      };
      onHealth?.(health);
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "NLQ search failed.");
      onHealth?.({ status: "error", hits: 0, latencyMs: Date.now() - started, message: error });
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
      <p>NLQ records search — answers about records, plus record actions, over the existing POST /nlq route.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. show my recent screens" />
        <Button type="submit" variant="primary" disabled={loading || !query.trim()} loading={loading}>
          {"Search"}
        </Button>
      </form>
      {/* Issue #1169 S4-4: this tab already retains the full native
          NLQ result in `result`, so it is downloaded verbatim. */}
      <Button type="button" onClick={() => downloadTextFile("nlq-results.json", buildJson(result), "application/json")} disabled={!result} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div>
          <p>
            {result.count ?? 0} results{result.domain ? ` · domain ${result.domain}` : ""}
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {result.summary && <p>{result.summary}</p>}
          {(result.rows || []).length > 20 && (
            <p>Showing first 20 of {(result.rows || []).length} rows.</p>
          )}
          {(result.rows || []).slice(0, 20).map((row, i) => (
            <p key={i}>{Object.values(row).map((v) => String(v)).join(" · ")}</p>
          ))}
        </div>
      )}
    </div>
  );
}
