/**
 * Issue #3525 S5 — broker/provider neutrality, live docs.
 *
 * Characterization pins: live documentation that presents the PLATFORM
 * names the capability/mechanism, not a provider brand. Each change pin
 * asserts the neutralized string is present in the doc and the
 * provider-as-platform framing it replaced is absent. Deferred rows
 * (accounted in the slice DESIGN.md) are pinned as UNCHANGED so a later
 * slice cannot silently absorb them: provenance enumerations naming the
 * actual serving source/route, integration-subject docs, dated records,
 * data-bearing identifiers, and the DISCLAIMER text mirrored from
 * landing.ts (reserved for the owner's accuracy decision).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("neutrality S5 — live docs presenting the platform", () => {
  it("README research export names the data, not the providers", () => {
    const src = read("README.md");
    expect(src).toContain("Export loaded market data and options research, screen evaluations");
    expect(src).not.toContain("Export loaded E*TRADE, Yahoo Finance, and options research data");
  });

  it("platform-capabilities discovery names the selected broker, not one brand", () => {
    const src = read("docs/architecture/business/platform-capabilities.md");
    expect(src).toContain("evaluates live contract chains from the selected broker against the 72-strategy catalog");
    expect(src).not.toContain("evaluates live E*TRADE contract chains");
  });

  it("screener-rules abstraction names the routed providers generically", () => {
    const src = read("docs/architecture/business/screener-rules.md");
    expect(src).toContain("Unified multi-broker screening over the routed providers");
    expect(src).not.toContain("Unified multi-broker (E*TRADE/Yahoo) screening");
  });

  it("standards third-party example names the broker role, not one brand", () => {
    const src = read("docs/architecture/standards/standards.md");
    expect(src).toContain("broker OAuth workflow policies");
    expect(src).not.toContain("E*TRADE OAuth2 workflow policies");
  });
});

describe("neutrality S5 — deferred rows pinned unchanged", () => {
  it("README Slack example keeps the deployed bot handle (data-bearing identifier)", () => {
    expect(read("README.md")).toContain("@ETradeAgent screen stocks");
  });

  it("DISCLAIMER stays mirrored with landing.ts (owner accuracy decision)", () => {
    expect(read("docs/DISCLAIMER.md")).toContain("in the E*TRADE sandbox (TEST) before using production");
  });

  it("workflow directory keeps its per-provider execution entries (integration documents)", () => {
    const src = read("docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md");
    expect(src).toContain("Brokerage Order Preview & HITL Execution (E*TRADE)");
    expect(src).toContain("Direct Equities & Crypto Order Placement (Alpaca)");
  });

  it("doors-and-layers keeps the provider-services inventory with status facts", () => {
    expect(read("docs/architecture/agentic/doors-and-layers.md")).toContain("Alpaca-behind-flag) behind the registry + breakers");
  });

  it("api-mcp keeps the provider endpoint inventory (route provenance)", () => {
    expect(read("docs/architecture/application/api-mcp.md")).toContain("GET /auth/etrade/start");
  });

  it("COMPLIANCE keeps the external-services inventory (hosts + purposes)", () => {
    expect(read("docs/COMPLIANCE.md")).toContain("https://api.etrade.com");
  });

  it("screener-workflow keeps per-element composition provenance", () => {
    expect(read("docs/architecture/business/screener-workflow.md")).toContain("quotes (E*TRADE batch, or Yahoo batch)");
  });

  it("data-operations docs already frame providers as adapters behind the ports", () => {
    expect(read("docs/operations/data/data-provider-platform.md")).toContain("per-provider adapters");
    expect(read("docs/operations/data/feed-jobs.md")).toContain("are unconditionally in scope");
  });
});
