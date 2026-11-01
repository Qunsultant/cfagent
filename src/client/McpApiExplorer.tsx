import React, { useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { TabHoverItem } from "./TabHoverItem";
import { Button, TextInput, Select } from "./components/ui";
import {
  MCP_TOOLS_CATALOG,
  MCP_RESOURCES_CATALOG,
  MCP_PROMPTS_CATALOG,
  REST_APIS_CATALOG,
  McpToolMeta,
  McpResourceMeta,
  McpPromptMeta,
  RestEndpointMeta,
} from "./mcpEndpointsData";

export function McpApiExplorer() {
  const [subTab, setSubTab] = useState<"tools" | "resources" | "prompts" | "rest" | "config">("tools");
  const [toolSearch, setToolSearch] = useState("");
  const [restCategoryFilter, setRestCategoryFilter] = useState<string>("all");

  // Interactive MCP Tool Call Runner State
  const [activeTool, setActiveTool] = useState<McpToolMeta>(MCP_TOOLS_CATALOG[0]);
  const [toolArgsJson, setToolArgsJson] = useState(JSON.stringify(MCP_TOOLS_CATALOG[0].sampleArgs, null, 2));
  const [mcpResult, setMcpResult] = useState<any>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState("");

  // Interactive MCP Resource Reader State
  const [activeResource, setActiveResource] = useState<McpResourceMeta>(MCP_RESOURCES_CATALOG[0]);
  const [resourceResult, setResourceResult] = useState<any>(null);
  const [resourceLoading, setResourceLoading] = useState(false);

  // Interactive MCP Prompt State
  const [activePrompt, setActivePrompt] = useState<McpPromptMeta>(MCP_PROMPTS_CATALOG[0]);
  const [promptResult, setPromptResult] = useState<any>(null);
  const [promptLoading, setPromptLoading] = useState(false);

  // Interactive REST API Runner State
  const [activeRest, setActiveRest] = useState<RestEndpointMeta>(REST_APIS_CATALOG[0]);
  const [restBodyJson, setRestBodyJson] = useState(
    REST_APIS_CATALOG[0].sampleBody ? JSON.stringify(REST_APIS_CATALOG[0].sampleBody, null, 2) : ""
  );
  const [restResponse, setRestResponse] = useState<any>(null);
  const [restStatusCode, setRestStatusCode] = useState<number | null>(null);
  const [restLatencyMs, setRestLatencyMs] = useState<number | null>(null);
  const [restLoading, setRestLoading] = useState(false);
  const [restError, setRestError] = useState("");

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 3000);
  };

  // Execute MCP Tool Call over live /api/mcp endpoint
  const handleExecuteMcpTool = async () => {
    setMcpLoading(true);
    setMcpResult(null);
    setMcpError("");
    try {
      let parsedArgs = {};
      if (toolArgsJson.trim()) {
        parsedArgs = JSON.parse(toolArgsJson);
      }

      const payload = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: activeTool.name,
          arguments: parsedArgs,
        },
      };

      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      setMcpResult(data);
    } catch (err: any) {
      setMcpError(err.message || "Failed to execute MCP request");
    } finally {
      setMcpLoading(false);
    }
  };

  // Read MCP Resource over live /api/mcp endpoint
  const handleReadResource = async (resMeta: McpResourceMeta) => {
    setActiveResource(resMeta);
    setResourceLoading(true);
    setResourceResult(null);
    try {
      const payload = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "resources/read",
        params: { uri: resMeta.uri },
      };

      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      setResourceResult(data);
    } catch (err: any) {
      setResourceResult({ error: err.message });
    } finally {
      setResourceLoading(false);
    }
  };

  // Get MCP Prompt over live /api/mcp endpoint
  const handleGetPrompt = async (pMeta: McpPromptMeta) => {
    setActivePrompt(pMeta);
    setPromptLoading(true);
    setPromptResult(null);
    try {
      const payload = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "prompts/get",
        params: { name: pMeta.name, arguments: {} },
      };

      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      setPromptResult(data);
    } catch (err: any) {
      setPromptResult({ error: err.message });
    } finally {
      setPromptLoading(false);
    }
  };

  // Execute Live REST API Request
  const handleSendRestRequest = async () => {
    setRestLoading(true);
    setRestResponse(null);
    setRestStatusCode(null);
    setRestLatencyMs(null);
    setRestError("");

    const startTime = performance.now();
    try {
      const options: RequestInit = {
        method: activeRest.method,
        headers: { "Content-Type": "application/json" },
      };

      if (activeRest.method === "POST" && restBodyJson.trim()) {
        options.body = restBodyJson;
      }

      const res = await fetch(activeRest.path, options);
      const elapsed = Math.round(performance.now() - startTime);

      setRestStatusCode(res.status);
      setRestLatencyMs(elapsed);

      let data: any;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawResponse: text };
      }
      setRestResponse(data);
    } catch (err: any) {
      setRestError(err.message || "Failed to send API request");
    } finally {
      setRestLoading(false);
    }
  };

  const filteredTools = MCP_TOOLS_CATALOG.filter(
    (t) =>
      t.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
      t.description.toLowerCase().includes(toolSearch.toLowerCase()) ||
      t.category.toLowerCase().includes(toolSearch.toLowerCase())
  );

  const filteredRest = REST_APIS_CATALOG.filter((r) =>
    restCategoryFilter === "all" ? true : r.category === restCategoryFilter
  );

  const claudeConfigSnippet = JSON.stringify(
    {
      mcpServers: {
        "openaimp-agent": {
          url: "https://agent.openaimp.com/api/mcp",
          headers: {
            "Content-Type": "application/json",
          },
        },
      },
    },
    null,
    2
  );

  const cursorConfigSnippet = JSON.stringify(
    {
      name: "OpenAIMP Multi-Agent Studio",
      type: "sse",
      url: "https://agent.openaimp.com/api/mcp",
    },
    null,
    2
  );

  return (
    <div className="endpoints-explorer-container">
      {/* Top Protocol Status Banner */}
      <div className="endpoints-hero-card">
        <div className="hero-badge-row">
          <span className="protocol-badge">⚡ Model Context Protocol (MCP) 2024-11-05</span>
          <span className="live-status-pill">● Server Active: JSON-RPC 2.0</span>
          <span className="transport-badge">HTTP POST & SSE Ready</span>
        </div>
        <h3>Model Context Protocol & REST API Developer Gateway</h3>
        <p>
          Seamlessly connect autonomous agents, Claude Desktop, Cursor, and enterprise workflows to Multi-Agent Studio.
          Expose, test, and introspect all 14 tools, 6 resources, 3 prompts, and 16 REST APIs with live execution.
        </p>

        {/* Global Endpoints Stats Ribbon */}
        <div className="endpoints-stats-ribbon">
          <div className="ep-stat">
            <span className="ep-num">14</span>
            <span className="ep-lbl">MCP Tools</span>
          </div>
          <div className="ep-stat">
            <span className="ep-num">6</span>
            <span className="ep-lbl">MCP Resources</span>
          </div>
          <div className="ep-stat">
            <span className="ep-num">3</span>
            <span className="ep-lbl">MCP Prompts</span>
          </div>
          <div className="ep-stat">
            <span className="ep-num">16</span>
            <span className="ep-lbl">REST Endpoints</span>
          </div>
          <div className="ep-stat">
            <span className="ep-num"><code>/api/mcp</code></span>
            <span className="ep-lbl">Unified Gateway</span>
          </div>
        </div>
      </div>

      {/* Sub-Navigation Switcher */}
      <div className="endpoints-subnav">
        <TabHoverItem
          eyebrow="MCP TOOL PROTOCOL"
          title="Callable Agent Tools"
          description="Browse and execute Model Context Protocol tools exposed to autonomous agent swarms."
        >
          <Button
          variant={subTab === "tools" ? "primary" : "secondary"}
            onClick={() => setSubTab("tools")}
          >
            🛠️ MCP Tools (14)
          </Button>
        </TabHoverItem>

        <TabHoverItem
          eyebrow="MCP RESOURCES"
          title="Context Resources"
          description="Read static and dynamic context resources provided by connected MCP servers."
        >
          <Button
          variant={subTab === "resources" ? "primary" : "secondary"}
            onClick={() => setSubTab("resources")}
          >
            📦 MCP Resources (6)
          </Button>
        </TabHoverItem>

        <TabHoverItem
          eyebrow="MCP PROMPTS"
          title="Agent Prompt Templates"
          description="Pre-configured system and agent prompt templates for specialized workflows."
        >
          <Button
          variant={subTab === "prompts" ? "primary" : "secondary"}
            onClick={() => setSubTab("prompts")}
          >
            💡 MCP Prompts (3)
          </Button>
        </TabHoverItem>

        <TabHoverItem
          eyebrow="HTTP REST API"
          title="REST Endpoints Explorer"
          description="Interactive cURL commands and response samples for all serverless HTTP routes."
        >
          <Button
          variant={subTab === "rest" ? "primary" : "secondary"}
            onClick={() => setSubTab("rest")}
          >
            🚀 REST APIs (16)
          </Button>
        </TabHoverItem>

        <TabHoverItem
          eyebrow="DEVELOPER CONFIGURATION"
          title="Claude & Cursor Config"
          description="Ready-to-copy JSON configuration files to connect Claude Desktop and Cursor IDE."
        >
          <Button
          variant={subTab === "config" ? "primary" : "secondary"}
            onClick={() => setSubTab("config")}
          >
            📋 Claude / Cursor Config
          </Button>
        </TabHoverItem>
      </div>

      {/* 1. MCP Tools View */}
      {subTab === "tools" && (
        <div className="endpoints-split-view">
          {/* Left: Tools List */}
          <div className="endpoints-list-pane">
            <div className="pane-header">
              <h4>Available MCP Tools ({filteredTools.length})</h4>
              <TextInput
                type="text"
                placeholder="Filter tools by name or description..."
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                className="filter-input"
              />
            </div>

            <div className="tools-cards-scroll">
              {filteredTools.map((t) => (
                <div
                  key={t.name}
                  className={`tool-item-card ${activeTool.name === t.name ? "selected" : ""}`}
                  onClick={() => {
                    setActiveTool(t);
                    setToolArgsJson(JSON.stringify(t.sampleArgs, null, 2));
                    setMcpResult(null);
                    setMcpError("");
                  }}
                >
                  <div className="tool-card-top">
                    <span className="tool-name"><code>{t.name}</code></span>
                    <span className="tool-cat-tag">{t.category}</span>
                  </div>
                  <p className="tool-desc">{t.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Interactive Test Sandbox */}
          <div className="endpoints-runner-pane">
            <div className="runner-header">
              <div className="runner-title-group">
                <span className="runner-badge">Interactive MCP Sandbox</span>
                <h4><code>{activeTool.name}</code></h4>
              </div>
              <span className="category-pill">{activeTool.category}</span>
            </div>
            <p className="runner-desc">{activeTool.description}</p>

            {/* Input Schema Parameters */}
            <div className="schema-section">
              <h5>Input Schema Parameters:</h5>
              <div className="schema-props-list">
                {Object.entries(activeTool.schema.properties || {}).map(([propName, propDef]: [string, any]) => {
                  const isRequired = (activeTool.schema.required || []).includes(propName);
                  return (
                    <div key={propName} className="prop-row">
                      <span className="prop-name"><code>{propName}</code></span>
                      <span className={`prop-type ${isRequired ? "required" : ""}`}>
                        {propDef.type} {isRequired ? "(required)" : "(optional)"}
                      </span>
                      <span className="prop-desc">{propDef.description}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* JSON Arguments Editor */}
            <div className="arguments-section">
              <div className="args-header">
                <h5>Call Arguments (JSON):</h5>
                <Button
                variant="secondary"
                size="sm"
                  className="reset-args-btn"
                  onClick={() => setToolArgsJson(JSON.stringify(activeTool.sampleArgs, null, 2))}
                >
                  ↺ Reset Sample
                </Button>
              </div>
              <TextInput multiline
                className="code-editor"
                rows={5}
                value={toolArgsJson}
                onChange={(e) => setToolArgsJson(e.target.value)}
              />
            </div>

            {/* Execution Trigger */}
            <div className="runner-actions">
              <Button
              variant="primary"
                className="run-mcp-btn"
                disabled={mcpLoading}
                onClick={handleExecuteMcpTool}
               loading={mcpLoading}>
                {"▶️ Send MCP Tool Call (Live)"}
              </Button>
            </div>

            {/* Live Result View */}
            {mcpError && <div className="runner-alert error">❌ {mcpError}</div>}
            {mcpResult && (
              <div className="runner-result-box">
                <div className="result-header">
                  <span className="result-tag success">JSON-RPC 2.0 Response</span>
                  <Button
                  variant="ghost"
                  size="sm"
                    className="copy-btn"
                    onClick={() => copyToClipboard(JSON.stringify(mcpResult, null, 2), "mcp-res")}
                  >
                    {copiedId === "mcp-res" ? "✓ Copied!" : "📋 Copy"}
                  </Button>
                </div>
                <pre className="result-pre">{JSON.stringify(mcpResult, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. MCP Resources View */}
      {subTab === "resources" && (
        <div className="endpoints-split-view">
          <div className="endpoints-list-pane">
            <div className="pane-header">
              <h4>Exposed MCP Resources ({MCP_RESOURCES_CATALOG.length})</h4>
              <p className="pane-sub">Direct access to stateful data records, revenue metrics, and memory vaults.</p>
            </div>
            <div className="tools-cards-scroll">
              {MCP_RESOURCES_CATALOG.map((res) => (
                <div
                  key={res.uri}
                  className={`tool-item-card ${activeResource.uri === res.uri ? "selected" : ""}`}
                  onClick={() => handleReadResource(res)}
                >
                  <div className="tool-card-top">
                    <span className="tool-name"><code>{res.uri}</code></span>
                    <span className="tool-cat-tag">JSON</span>
                  </div>
                  <h5 className="res-title">{res.name}</h5>
                  <p className="tool-desc">{res.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="endpoints-runner-pane">
            <div className="runner-header">
              <div className="runner-title-group">
                <span className="runner-badge">Live Resource Inspector</span>
                <h4><code>{activeResource.uri}</code></h4>
              </div>
              <Button
              variant="primary"
                className="run-mcp-btn"
                disabled={resourceLoading}
                onClick={() => handleReadResource(activeResource)}
               loading={resourceLoading}>
                {"📖 Read Resource"}
              </Button>
            </div>
            <p className="runner-desc">{activeResource.description}</p>

            {resourceResult && (
              <div className="runner-result-box">
                <div className="result-header">
                  <span className="result-tag success">Live Resource Content</span>
                  <Button
                  variant="ghost"
                  size="sm"
                    className="copy-btn"
                    onClick={() => copyToClipboard(JSON.stringify(resourceResult, null, 2), "res-res")}
                  >
                    {copiedId === "res-res" ? "✓ Copied!" : "📋 Copy"}
                  </Button>
                </div>
                <pre className="result-pre">{JSON.stringify(resourceResult, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. MCP Prompts View */}
      {subTab === "prompts" && (
        <div className="endpoints-split-view">
          <div className="endpoints-list-pane">
            <div className="pane-header">
              <h4>Pre-Engineered Agent Prompts ({MCP_PROMPTS_CATALOG.length})</h4>
              <p className="pane-sub">Structured reasoning prompts for security audits and revenue analysis.</p>
            </div>
            <div className="tools-cards-scroll">
              {MCP_PROMPTS_CATALOG.map((p) => (
                <div
                  key={p.name}
                  className={`tool-item-card ${activePrompt.name === p.name ? "selected" : ""}`}
                  onClick={() => handleGetPrompt(p)}
                >
                  <div className="tool-card-top">
                    <span className="tool-name"><code>{p.name}</code></span>
                    <span className="tool-cat-tag">{p.args.length} args</span>
                  </div>
                  <p className="tool-desc">{p.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="endpoints-runner-pane">
            <div className="runner-header">
              <div className="runner-title-group">
                <span className="runner-badge">Prompt Generator</span>
                <h4><code>{activePrompt.name}</code></h4>
              </div>
              <Button
              variant="primary"
                className="run-mcp-btn"
                disabled={promptLoading}
                onClick={() => handleGetPrompt(activePrompt)}
               loading={promptLoading}>
                {"💬 Get Prompt Preview"}
              </Button>
            </div>
            <p className="runner-desc">{activePrompt.description}</p>

            <div className="schema-section">
              <h5>Prompt Arguments:</h5>
              <div className="schema-props-list">
                {activePrompt.args.map((a) => (
                  <div key={a.name} className="prop-row">
                    <span className="prop-name"><code>{a.name}</code></span>
                    <span className="prop-desc">{a.description}</span>
                  </div>
                ))}
              </div>
            </div>

            {promptResult && (
              <div className="runner-result-box">
                <div className="result-header">
                  <span className="result-tag success">Prompt Messages</span>
                </div>
                <pre className="result-pre">{JSON.stringify(promptResult, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. REST APIs View */}
      {subTab === "rest" && (
        <div className="endpoints-split-view">
          <div className="endpoints-list-pane">
            <div className="pane-header">
              <h4>Platform REST Endpoints ({filteredRest.length})</h4>
              <Select
                className="category-filter-select"
                value={restCategoryFilter}
                onChange={(e) => setRestCategoryFilter(e.target.value)}
              >
                <option value="all">All Categories ({REST_APIS_CATALOG.length})</option>
                <option value="Agents & NLQ">Agents & NLQ</option>
                <option value="Payments & DIDs">Payments & DIDs</option>
                <option value="Enterprise Data & Ledger">Enterprise Data & Ledger</option>
                <option value="Monetization & Ads">Monetization & Ads</option>
                <option value="Referrals & Community">Referrals & Community</option>
                <option value="System & Audit">System & Audit</option>
              </Select>
            </div>

            <div className="tools-cards-scroll">
              {filteredRest.map((r) => (
                <div
                  key={r.id}
                  className={`tool-item-card ${activeRest.id === r.id ? "selected" : ""}`}
                  onClick={() => {
                    setActiveRest(r);
                    setRestBodyJson(r.sampleBody ? JSON.stringify(r.sampleBody, null, 2) : "");
                    setRestResponse(null);
                    setRestStatusCode(null);
                    setRestLatencyMs(null);
                    setRestError("");
                  }}
                >
                  <div className="tool-card-top">
                    <span className={`method-tag ${r.method.toLowerCase()}`}>{r.method}</span>
                    <span className="path-text"><code>{r.path}</code></span>
                  </div>
                  <h5 className="rest-title">{r.title}</h5>
                  <p className="tool-desc">{r.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="endpoints-runner-pane">
            <div className="runner-header">
              <div className="runner-title-group">
                <span className={`method-pill ${activeRest.method.toLowerCase()}`}>{activeRest.method}</span>
                <h4><code>{activeRest.path}</code></h4>
              </div>
              <span className="auth-pill">{activeRest.authRequired ? "🔒 Auth Required" : "🌐 Public"}</span>
            </div>
            <p className="runner-desc">{activeRest.description}</p>

            {/* Request Body if POST */}
            {activeRest.method === "POST" && (
              <div className="arguments-section">
                <div className="args-header">
                  <h5>Request Body (JSON):</h5>
                  {activeRest.sampleBody && (
                    <Button
                    variant="secondary"
                    size="sm"
                      className="reset-args-btn"
                      onClick={() => setRestBodyJson(JSON.stringify(activeRest.sampleBody, null, 2))}
                    >
                      ↺ Load Sample
                    </Button>
                  )}
                </div>
                <TextInput multiline
                  className="code-editor"
                  rows={4}
                  value={restBodyJson}
                  onChange={(e) => setRestBodyJson(e.target.value)}
                />
              </div>
            )}

            {/* Execute Request */}
            <div className="runner-actions">
              <Button
              variant="primary"
                className="run-mcp-btn"
                disabled={restLoading}
                onClick={handleSendRestRequest}
               loading={restLoading}>
                {`▶️ Send ${activeRest.method} Request (Live)`}
              </Button>
            </div>

            {/* Copyable cURL */}
            <div className="curl-section">
              <div className="curl-header">
                <h5>Sample cURL Command:</h5>
                <Button
                variant="ghost"
                size="sm"
                  className="copy-btn"
                  onClick={() => copyToClipboard(activeRest.sampleCurl, `curl-${activeRest.id}`)}
                >
                  {copiedId === `curl-${activeRest.id}` ? "✓ Copied!" : "📋 Copy cURL"}
                </Button>
              </div>
              <pre className="curl-code"><code>{activeRest.sampleCurl}</code></pre>
            </div>

            {/* Documented Response Shape (issue #325) */}
            {activeRest.sampleResponse && (
              <div className="curl-section">
                <div className="curl-header">
                  <h5>Sample Response (JSON):</h5>
                </div>
                <pre className="curl-code"><code>{JSON.stringify(activeRest.sampleResponse, null, 2)}</code></pre>
              </div>
            )}

            {/* Live Response */}
            {restError && <div className="runner-alert error">❌ {restError}</div>}
            {restResponse && (
              <div className="runner-result-box">
                <div className="result-header">
                  <div className="status-group">
                    <span className={`status-code ${restStatusCode && restStatusCode < 400 ? "ok" : "err"}`}>
                      {restStatusCode} {restStatusCode === 200 ? "OK" : ""}
                    </span>
                    {restLatencyMs !== null && <span className="latency-tag">⚡ {restLatencyMs}ms</span>}
                  </div>
                  <Button
                  variant="ghost"
                  size="sm"
                    className="copy-btn"
                    onClick={() => copyToClipboard(JSON.stringify(restResponse, null, 2), "rest-res")}
                  >
                    {copiedId === "rest-res" ? "✓ Copied!" : "📋 Copy JSON"}
                  </Button>
                </div>
                <pre className="result-pre">{JSON.stringify(restResponse, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. Client Integrations (Claude Desktop & Cursor) */}
      {subTab === "config" && (
        <div className="client-config-container">
          <div className="config-grid">
            {/* Claude Desktop */}
            <div className="config-card">
              <div className="config-header">
                <span className="config-icon">🤖</span>
                <div>
                  <h4>Claude Desktop Configuration</h4>
                  <p>Add Multi-Agent Studio to Claude Desktop by editing <code>claude_desktop_config.json</code>.</p>
                </div>
              </div>
              <div className="code-box-header">
                <span><code>claude_desktop_config.json</code></span>
                <Button
                variant="ghost"
                size="sm"
                  className="copy-btn"
                  onClick={() => copyToClipboard(claudeConfigSnippet, "claude-cfg")}
                >
                  {copiedId === "claude-cfg" ? "✓ Copied Config!" : "📋 Copy Config"}
                </Button>
              </div>
              <pre className="config-pre"><code>{claudeConfigSnippet}</code></pre>
            </div>

            {/* Cursor IDE */}
            <div className="config-card">
              <div className="config-header">
                <span className="config-icon">⚡</span>
                <div>
                  <h4>Cursor IDE Integration</h4>
                  <p>Configure Cursor Features → MCP to use this server's real-time tools.</p>
                </div>
              </div>
              <div className="code-box-header">
                <span>Cursor MCP Settings</span>
                <Button
                variant="ghost"
                size="sm"
                  className="copy-btn"
                  onClick={() => copyToClipboard(cursorConfigSnippet, "cursor-cfg")}
                >
                  {copiedId === "cursor-cfg" ? "✓ Copied Config!" : "📋 Copy Config"}
                </Button>
              </div>
              <pre className="config-pre"><code>{cursorConfigSnippet}</code></pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
