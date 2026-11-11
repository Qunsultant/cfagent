// @vitest-environment node
/**
 * Issue #4102 — every copilot tool a broker declares in BROKER_CATALOG must
 * be registered in SYNCHRONOUS_MCP_TOOLS.
 *
 * Why: the MCP dispatcher wraps a tool as an async job when the delivery mode
 * is "queued" and `!isSynchronousMcpTool(name)` (src/mcps/openaimp/handler.ts).
 * An unregistered tool therefore answers with `{jobId, status: "queued"}`
 * instead of a result — which is what happened to Public.com's five tools
 * (#3990 added them to the catalog and to the factory, never to this set), so
 * asking for a quote returned eight job receipts and nothing reached the
 * broker.
 *
 * The expectation is derived from the catalog, never hand-written: adding a
 * broker, or a tool to one, without registering it fails here by name. This is
 * the pin #3990 lacked.
 */
import { describe, it, expect } from "vitest";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";

type BrokerId = keyof typeof BROKER_CATALOG;
const SLOTS = ["quote", "preview", "place", "orders", "cancel"] as const;

const declared: Array<{ broker: string; slot: string; tool: string }> = [];
for (const broker of Object.keys(BROKER_CATALOG) as BrokerId[]) {
  const tools = BROKER_CATALOG[broker].copilot.tools;
  for (const slot of SLOTS) {
    const name = tools[slot];
    if (typeof name === "string" && name.length > 0) {
      declared.push({ broker, slot, tool: name });
    }
  }
}

describe("synchronous broker tools (#4102)", () => {
  it("derives its expectation from the catalog", () => {
    // A pin that derives nothing from nothing would pass silently.
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.some((d) => d.broker === "public")).toBe(true);
  });

  it("registers every catalog-declared copilot tool as synchronous", () => {
    const missing = declared
      .filter((d) => !isSynchronousMcpTool(d.tool))
      .map((d) => `${d.broker}.${d.slot}=${d.tool}`);
    expect(missing).toEqual([]);
  });

  it("keeps a genuinely asynchronous tool queued, so the gate still has a subject", () => {
    // The pin must not be satisfiable by making everything synchronous.
    expect(isSynchronousMcpTool("some_tool_nobody_registered")).toBe(false);
  });
});
