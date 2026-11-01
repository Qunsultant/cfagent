/**
 * Issue #1763 — tool-attribution audit pin. The audit doc
 * (docs/architecture/security/tool-attribution-audit-1763.md) must
 * name every factory tool (from #1843's MCP_TOOL_SCOPES, pinned
 * against the live registry) and every scanner tool, so a future
 * tool added without an audit row fails loudly instead of silently
 * becoming unattributed. The doc is the record; this test is the
 * drift pin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";

describe("Tool-attribution audit coverage (#1763)", () => {
  it("audit doc names all 83 factory tools and the 4 scanner tools", () => {
    const doc = readFileSync(
      join(__dirname, "../docs/architecture/security/tool-attribution-audit-1763.md"),
      "utf8",
    );
    const tools = Object.keys(MCP_TOOL_SCOPES);
    // #1906: 51 canonical tools + 9 deprecated aliases (foss_*), which
    // share their canonical tool's scope and must be named in the audit
    // doc too — a callable alias without an audit row would be
    // unattributed by this test's own rationale.
    // #2250: +1 canonical tool (ai_search_agent_search) = 52 canonical.
    // #2341: +4 canonical mesh-door tools = 56 canonical.
    // #2349: +7 canonical mesh-door tools (batch B) = 63 canonical.
    // #2351: +5 canonical mesh-door tools (batch C) = 68 canonical.
    // #2375: +3 canonical mesh-door tools (batch D) = 71 canonical.
    // #2428: +1 canonical AgentDB-read tool (agentdb.trace.get) = 72 canonical.
    // #2488: +1 canonical mesh-door tool (run_stock_screen) = 73 canonical.
    // #2581: +1 canonical mesh-door tool (run_options_strategy_screen) = 74 canonical.
    expect(tools).toHaveLength(83);
    for (const tool of tools) {
      expect(doc).toContain(`\`${tool}\``);
    }
    for (const scanner of ["screen_options", "scanner_status", "get_scan_job", "list_scan_jobs"]) {
      expect(doc).toContain(`\`${scanner}\``);
    }
    for (const gap of ["G-AUD-1", "G-AUD-2", "G-AUD-3", "G-AUD-4", "G-AUD-5", "G-AUD-6"]) {
      expect(doc).toContain(gap);
    }
  });
});
