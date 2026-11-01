import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps } from "../searchTabTypes";

interface MasChunk {
  title?: string;
  snippet?: string;
  source?: string;
  reportId?: string;
  createdAt?: string;
  score?: number;
  bucketKey?: string;
  servedFileLink?: string;
  indexingState?: string;
  url?: string;
}

/**
 * MAS-search tab (#1169 S4-2, revised scope) — the MAS searchKnowledge
 * tool itself, with a UI, via POST /api/search/mas. The tool's native
 * result shape is rendered as-is: merged scheduled-report chunks first,
 * then AI Search index chunks, capped at 5 by the tool. Each chunk
 * carries a per-chunk source label (scheduled_report vs index chunk),
 * so the merge is visible, never blended.
 *
 * Deliberate exception to the hub's separate-lists rule: this tab's
 * value IS the merge (local reports + instance chunks in one list).
 * The MAS message and source are rendered honestly, including the
 * upstream-unavailable local-only message and the tool's error shape
 * (which arrives with HTTP 200 — the error field, not the status,
 * is what marks it). Provenance fields appear only when the tool
 * attached them (flag-on serving); chunks without a bucketKey get no
 * served-file link, displayed by omission, never papered over.
 */
export function SearchMasTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [chunks, setChunks] = useState<MasChunk[]>([]);
  // Issue #1169 S4-4: the last successful raw tool response,
  // retained verbatim for the Download button (native shape, no
  // envelope). Cleared on the error-shape path because this tab
  // hides prior results when the tool errors (searched && !error).
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("");
  const [reportCount, setReportCount] = useState(0);
  const [indexCount, setIndexCount] = useState(0);
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
      const res = await apiFetch("/api/search/mas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "MAS search failed.");
      if (data.error) {
        setError(data.error);
        setLastResult(null);
        setSearched(true);
        onHealth?.({ status: "error", hits: 0, latencyMs: Date.now() - started });
        return;
      }
      const list: MasChunk[] = data.chunks || [];
      setChunks(list);
      setLastResult(data);
      setMessage(data.message || "");
      setSource(data.source || "");
      setReportCount(typeof data.reportCount === "number" ? data.reportCount : 0);
      setIndexCount(typeof data.count === "number" ? data.count : 0);
      setSearched(true);
      const ms = Date.now() - started;
      setLatencyMs(ms);
      onHealth?.({
        status: list.length > 0 ? "ok" : "empty",
        hits: list.length,
        latencyMs: ms,
      });
      onSearch?.(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MAS search failed.");
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
      <p>MAS Search — the MAS searchKnowledge tool: scheduled-run reports merged with AI Search instance results, in one source-labeled list.</p>
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
      <Button type="button" onClick={() => downloadTextFile("mas-search-results.json", buildJson(lastResult), "application/json")} disabled={!lastResult} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {error && <p role="alert">{error}</p>}
      {searched && !error && (
        <div>
          <p>
            {chunks.length} results · {reportCount} scheduled report(s) · {indexCount} index chunk(s)
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </p>
          {message && <p>{message}</p>}
          {source && <p>Source: {source}</p>}
          {chunks.map((c, i) => (
            <div key={i}>
              <p>
                <strong>{c.title || "Untitled"}</strong>
                {c.source === "scheduled_report" ? " · Scheduled report" : " · AI Search index chunk"}
                {c.score !== undefined ? ` · score ${c.score}` : ""}
              </p>
              {c.snippet && <p>{c.snippet}</p>}
              {c.source === "scheduled_report" && (
                <p>
                  {c.reportId ? `Report: ${c.reportId}` : ""}
                  {c.createdAt ? ` · ${c.createdAt}` : ""}
                </p>
              )}
              {c.servedFileLink && (
                <p>
                  <a href={c.servedFileLink}>Served file</a>
                  {c.bucketKey ? ` · ${c.bucketKey}` : ""}
                  {c.indexingState ? ` · ${c.indexingState}` : ""}
                </p>
              )}
              {c.url && !c.servedFileLink && (
                <p>
                  <a href={c.url}>{c.url}</a>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
