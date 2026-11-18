import React, { useEffect, useRef, useState } from "react";
import { Button, TextInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import {
  MCP_TOOLS_CATALOG,
  MCP_RESOURCES_CATALOG,
  MCP_PROMPTS_CATALOG,
  REST_APIS_CATALOG,
} from "../../mcpEndpointsData";
import type { SearchTabProps } from "../searchTabTypes";

/**
 * Tool catalog tab — client-side filter over the mcpEndpointsData
 * catalogs (same name/description/category includes pattern as
 * McpApiExplorer.toolSearch). No backend, no network: the catalog is
 * the data. Note the catalog does not contain every MCP tool name
 * (e.g. ai_search_financial_docs lives in cloudflareAgentCommands
 * only) — the tab searches what the catalog holds and says so.
 */
export function ToolSearchTab({ pendingQuery, onHealth, onSearch }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ kind: string; name: string; category: string; description: string }>>([]);
  const [searched, setSearched] = useState(false);
  const lastNonce = useRef(0);

  function run(q: string) {
    const needle = q.trim().toLowerCase();
    if (!needle) return;
    const started = Date.now();
    const match = (name: string, description: string, category: string) =>
      name.toLowerCase().includes(needle) ||
      description.toLowerCase().includes(needle) ||
      category.toLowerCase().includes(needle);
    const found: Array<{ kind: string; name: string; category: string; description: string }> = [];
    for (const t of MCP_TOOLS_CATALOG) {
      if (match(t.name, t.description, t.category)) {
        found.push({ kind: "tool", name: t.name, category: t.category, description: t.description });
      }
    }
    // Resources and prompts carry no category field — match on
    // name/description only. REST entries carry no name — match on
    // title/path and display the title.
    for (const r of MCP_RESOURCES_CATALOG) {
      if (r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle)) {
        found.push({ kind: "resource", name: r.name, category: "", description: r.description });
      }
    }
    for (const p of MCP_PROMPTS_CATALOG) {
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

  return (
    <div>
      <p>Tool catalog search — MCP tools, resources, prompts, and REST endpoints from the client catalog (no network).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <TextInput label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. knowledge_search" />
        <Button type="submit" variant="primary" disabled={!query.trim()}>
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
