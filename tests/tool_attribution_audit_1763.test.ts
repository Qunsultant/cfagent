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
import { McpToolFactory } from "../src/mcps/openaimp/commands";

describe("Tool-attribution audit coverage (#1763)", () => {
  it("every factory tool declares exactly one scope, and every scope names a live tool (#3917)", () => {
    // The accounting pin that replaces eleven per-suite catalog counts: adding
    // a tool without declaring its scope (or declaring a scope for a tool the
    // factory never registers) fails here, once, instead of rewriting a literal
    // in eleven files and colliding with every other lane.
    const factory = McpToolFactory.getAllTools().map((tool) => tool.name).sort();
    const declared = Object.keys(MCP_TOOL_SCOPES).sort();
    expect(factory).toEqual(declared);
  });


  it("audit doc names every factory tool and the 4 scanner tools", () => {
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
    // #2731: +1 canonical tool (web_search) = 75 canonical.
    // #2760: +1 canonical tool (web_fetch) = 76 canonical.
    // #3513: +2 canonical mesh-door tools (stock_copilot_status, stock_copilot_control) = 78 canonical.
    // #3588: +1 canonical mesh-door tool (stock_copilot_introspect) = 79 canonical.
    // #3514: +2 canonical mesh-door tools (stock_copilot_learnings, stock_copilot_evaluate) = 81 canonical.
    // #3535: +4 canonical feed-job tools (run/get/list/manage) = 85 canonical.
    // #3536: +4 canonical enrich-job tools (run/get/list/manage) = 89 canonical.
    // #3537: +4 canonical analyze-job tools (run/get/list/manage) = 93 canonical.
    // #3538: +4 canonical generate-job tools (run/get/list/manage) = 97 canonical.
    // #3539: +4 canonical deliver-job tools (run/get/list/manage) = 101 canonical.
    // #3673: +2 canonical bracket ladder tools (place/cancel) = 103 canonical.
    // #3540: +4 canonical pipeline-chain tools (run/get/list/manage) = 107 canonical (116 total with 9 foss_* aliases).
    // #3530 slice B: +2 canonical feed-job schedule tools (get/set_feed_job_schedule) = 109 canonical (120 total with 9 foss_* aliases).
    // #3782: +2 canonical Alpaca tools (alpaca_get_quote, alpaca_preview_order) = 111 canonical (122 total with 9 foss_* aliases).
    // Issue #3917: the catalog SIZE is not pinned here — one new tool would
    // rewrite this line in eleven suites. The tool↔scope accounting pin lives
    // in tests/tool_attribution_audit_1763.test.ts (sets must match exactly).
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
