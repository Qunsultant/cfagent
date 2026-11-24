import React, { useEffect, useRef, useState } from "react";
import { Button, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import { fetchMcpCatalog, type ClientMcpCatalog } from "../../mcpCatalog";
import { REST_APIS_CATALOG } from "../../restEndpointsData";
import type { SearchTabProps } from "../searchTabTypes";

/**
 * Tool catalog tab — searches the served catalogue (GET
 * /api/mcp/catalog, #6438) instead of a hand-maintained client file.
 * A newly registered tool appears here after deploy, with no
 * client-file edit. The load fails closed: a failed fetch renders an
 * error, never a stale list. Tool categories are the tools'
 * permission scopes, as served.
 */
export function ToolSearchTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ kind: string; name: string; category: string; description: string }>>([]);
  const [searched, setSearched] = useState(false);
  const [catalog, setCatalog] = useState<ClientMcpCatalog | null>(null);
  const [loadError, setLoadError] = useState("");
  const lastNonce = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetchMcpCatalog()
      .then((loaded) => {
        if (!cancelled) setCatalog(loaded);
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.message || "Failed to load the tool catalog");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function run(q: string) {
    const needle = q.trim().toLowerCase();
    if (!needle || !catalog) return;
    const started = Date.now();
    const match = (name: string, description: string, category: string) =>
      name.toLowerCase().includes(needle) ||
      description.toLowerCase().includes(needle) ||
      category.toLowerCase().includes(needle);
    const found: Array<{ kind: string; name: string; category: string; description: string }> = [];
    for (const t of catalog.tools) {
      if (match(t.name, t.description, t.category)) {
        found.push({ kind: "tool", name: t.name, category: t.category, description: t.description });
      }
    }
    // Resources and prompts carry no category field — match on
    // name/description only. REST entries carry no name — match on
    // title/path and display the title.
    for (const r of catalog.resources) {
      if (r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle)) {
        found.push({ kind: "resource", name: r.name, category: "", description: r.description });
      }
    }
    for (const p of catalog.prompts) {
      if (p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle)) {
        found.push({ kind: "prompt", name: p.name, category: "", description: p.description });
      }
    }
    for (const e of REST_APIS_CATALOG) {
      if (match(e.title, e.description, e.category) || e.path.toLowerCase().includes(needle)) {
        found.push({ kind: "rest", name: e.title, category: e.category, description: e.description });
      }
    }
    setResults(found);
    setSearched(true);
    onHealth?.({ status: found.length > 0 ? "ok" : "empty", hits: found.length, latencyMs: Date.now() - started });
    onSearch?.(q.trim());
  }

  useEffect(() => {
    if (pendingQuery && pendingQuery.nonce !== lastNonce.current) {
      lastNonce.current = pendingQuery.nonce;
      setQuery(pendingQuery.query);
      run(pendingQuery.query);
    }
  }, [pendingQuery]);

  // A query typed (or pending) before the catalogue finished loading
  // runs against the served data once it arrives.
  useEffect(() => {
    if (catalog && query.trim() && !searched) run(query);
  }, [catalog]);

  return (
    <div>
      <p>Tool catalog search — MCP tools, resources, prompts, and REST endpoints from the server catalogue.</p>
      {loadError && <p>{loadError}</p>}
      {!catalog && !loadError && <p>Loading the server catalogue…</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. knowledge_search" />
        <Button type="submit" variant="primary" disabled={!query.trim() || !catalog}>
          Search
        </Button>
      </form>
      {/* Issue #1169 S4-4: no backend response exists here — the
          filtered list itself is the tab's native result shape. */}
      <Button type="button" onClick={() => downloadTextFile("tool-search-results.json", buildJson(results), "application/json")} disabled={!searched} title="Download current results as JSON">
        Download results (JSON)
      </Button>
      {searched && (
        <div>
          <p>{results.length} results</p>
          {results.map((r, i) => (
            <p key={i}>
              [{r.kind}] {r.name} · {r.category} · {r.description}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
