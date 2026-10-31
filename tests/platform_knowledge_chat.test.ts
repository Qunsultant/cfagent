import { describe, it, expect, beforeEach } from "vitest";
import { searchPlatformKnowledge, PLATFORM_WORKFLOWS_KNOWLEDGE } from "../src/services/platformKnowledge";
import { McpToolFactory, QueryPlatformKnowledgeCommand, KnowledgeSearchCommand } from "../src/mcps/openaimp/commands";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import { handlerDispatch, makeDiscoveredPlatformTools } from "./mesh-mcp-testkit";
import { McpSystemFacade } from "../src/patterns/facade";
import { LLMJudge } from "../src/agents/judge";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

describe("Platform Capabilities & Chat Knowledge Retrieval Suite", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "", // Empty endpoint to test resilient internal platform knowledge fallback
    SEARCH_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  };
  const auditLogs: any[] = [];
  const auditMock = (type: string, agent: any, payload: Record<string, unknown>) => {
    auditLogs.push({ type, agent, payload });
  };
  const sessionId = "session_platform_test";

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    auditLogs.length = 0;
  });

  describe("1. Platform Knowledge Service (searchPlatformKnowledge)", () => {
    it("indexes all 8 core platform workflows with full details", () => {
      expect(PLATFORM_WORKFLOWS_KNOWLEDGE.length).toBe(8);
      const workflowIds = PLATFORM_WORKFLOWS_KNOWLEDGE.map((w) => w.id);
      expect(workflowIds).toContain("stock-screener");
      expect(workflowIds).toContain("options-strategy-discovery");
      expect(workflowIds).toContain("options-flows");
      expect(workflowIds).toContain("strategy-builder");
      expect(workflowIds).toContain("portfolio-positions-sync");
      expect(workflowIds).toContain("automated-execution-hitl");
      expect(workflowIds).toContain("background-cron-scheduling");
      expect(workflowIds).toContain("nlq-conversational-agent");
    });

    it("returns general platform overview when query is empty or broad", () => {
      const result = searchPlatformKnowledge("");
      expect(result.formattedAnswer).toContain("Platform Capabilities & How to Use Multi-Agent Studio");
      expect(result.formattedAnswer).toContain("8 core workflows");
      expect(result.formattedAnswer).toContain("Stock Screener");
      expect(result.formattedAnswer).toContain("Options Strategy Discovery");
      expect(result.formattedAnswer).toContain("Options Flow");
    });

    it("retrieves stock screener instructions and fallback hierarchy", () => {
      const result = searchPlatformKnowledge("How do I use the stock screener?");
      expect(result.count).toBeGreaterThan(0);
      const hasStockWorkflow = result.results.some((r) => r.id === "stock-screener" || r.id === "stock-screener-logic");
      expect(hasStockWorkflow).toBe(true);
      expect(result.formattedAnswer).toContain("trading");
      expect(result.formattedAnswer).toMatch(/nasdaq|fallback|rsi/i);
    });

    it("retrieves options strategy discovery with budget risk (max profit > 0, max loss <= 30)", () => {
      const result = searchPlatformKnowledge("How to find max profit > 0 and max loss <= 30?");
      expect(result.count).toBeGreaterThan(0);
      expect(result.formattedAnswer).toMatch(/defined-risk|budget|max\s*loss/i);
      expect(result.formattedAnswer).toContain("trading");
    });

    it("retrieves PickBestTrades decision engine logic and composite scoring", () => {
      const result = searchPlatformKnowledge("Explain how PickBestTrades evaluates and scores setups");
      expect(result.count).toBeGreaterThan(0);
      const match = result.results.find(
        (r) => r.id === "pickbesttrades-engine" || /pick\s*best\s*trade/i.test(r.title)
      );
      expect(match).toBeDefined();
      expect(result.formattedAnswer).toMatch(/expected value|pop|liquidity|score/i);
    });

    it("retrieves Human-in-the-Loop (HITL) order execution workflow and DID attestation", () => {
      const result = searchPlatformKnowledge("How does HITL order execution and DID attestation work?");
      expect(result.count).toBeGreaterThan(0);
      const match = result.results.find((r) => r.id === "automated-execution-hitl");
      expect(match).toBeDefined();
      expect(result.formattedAnswer).toMatch(/did|human|preview|execute/i);
    });

    it("retrieves real-time options flow and institutional sweeps", () => {
      const result = searchPlatformKnowledge("options flow sweeps and blocks");
      expect(result.count).toBeGreaterThan(0);
      const match = result.results.find((r) => r.id === "options-flows");
      expect(match).toBeDefined();
      expect(result.formattedAnswer).toContain("options-flows");
    });

    it("retrieves the complete 14-workflow directory breakdown for analysis and execution", () => {
      const result = searchPlatformKnowledge("how many workflows are there for both analysis and execution and what components/apis are leveraged to enable them");
      expect(result.count).toBe(14);
      expect(result.formattedAnswer).toContain("14 Total Workflows");
      expect(result.formattedAnswer).toContain("Part 1: Analysis Workflows (8 Workflows");
      expect(result.formattedAnswer).toContain("Part 2: Execution Workflows (6 Workflows");
      expect(result.formattedAnswer).toMatch(/A1.*Stock Screener/);
      expect(result.formattedAnswer).toMatch(/E1.*Brokerage Order Preview/);
    });
  });

  describe("2. MCP Command: QueryPlatformKnowledgeCommand", () => {
    it("is registered in McpToolFactory", () => {
      const tool = McpToolFactory.getTool("query_platform_knowledge");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("query_platform_knowledge");
    });

    it("executes query_platform_knowledge directly and returns structured answers", async () => {
      const cmd = new QueryPlatformKnowledgeCommand();
      const context = {
        env: mockEnv,
        orm,
        sessionId,
        audit: auditMock,
      };

      const result = await cmd.execute({ query: "What are the platform capabilities?" }, context);
      expect(result.count).toBeGreaterThan(0);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.answer).toContain("Workflow");
      expect(auditLogs.some((l) => l.payload?.tool === "query_platform_knowledge")).toBe(true);
    });
  });

  describe("3. MCP Command: KnowledgeSearchCommand Fallback", () => {
    it("falls back to searchPlatformKnowledge when AI_SEARCH_ENDPOINT is empty or has 0 chunks", async () => {
      const cmd = new KnowledgeSearchCommand();
      const context = {
        env: mockEnv, // AI_SEARCH_ENDPOINT is empty
        orm,
        sessionId,
        audit: auditMock,
      };

      const result = await cmd.execute({ query: "How to use the stock screener and options flows?" }, context);
      expect(result.count).toBeGreaterThan(0);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.message).toContain("Platform Knowledge Base");
      expect(result.chunks[0].title).toBeDefined();
      expect(result.chunks[0].text).toBeDefined();
    });
  });

  describe("4. LLMJudge Intent Routing for Platform Capability Questions", () => {
    it("routes platform capability inquiries to 'search' with high confidence and needsConfirmation: false", async () => {
      const judge = new LLMJudge(mockEnv);

      const decision1 = await judge.route("What are the capabilities of this platform?");
      expect(decision1.agent).toBe("search");
      expect(decision1.confidence).toBeGreaterThanOrEqual(0.95);
      expect(decision1.needsConfirmation).toBe(false);

      const decision2 = await judge.route("How do I use the stock screener?");
      expect(decision2.agent).toBe("search");
      expect(decision2.needsConfirmation).toBe(false);

      const decision3 = await judge.route("Explain how PickBestTrades evaluates and ranks options strategies");
      expect(decision3.agent).toBe("search");
      expect(decision3.needsConfirmation).toBe(false);

      const decision4 = await judge.route("How to execute an option strategy with max profit > 0 and max loss <= 30?");
      expect(decision4.agent).toBe("search");
      expect(decision4.needsConfirmation).toBe(false);
    });

    it("preserves trading routing for active order execution attempts", async () => {
      const judge = new LLMJudge(mockEnv);
      const tradeDecision = await judge.route("Buy 50 shares of AAPL at limit 210.00");
      expect(tradeDecision.agent).toBe("trading");
      expect(tradeDecision.needsConfirmation).toBe(true);
    });
  });

  describe("5. McpAgentToolAdapter & createAgentMcpTools", () => {
    it("exposes query_platform_knowledge and aliases in agent tools", async () => {
      const facade = new McpSystemFacade(mockEnv, orm, sessionId);
      const tools = createAgentMcpTools({
        env: mockEnv,
        orm,
        sessionId,
        facade,
        audit: auditMock,
      });

      // #2496: catalog commands are no longer adapted into the
      // native set — the turn DISCOVERS them from the openaimp
      // server under tool_openaimp_<name> keys, and the camelCase
      // aliases were retired with the hand-wired layer.
      expect(tools["query_platform_knowledge"]).toBeUndefined();
      expect(tools["queryPlatformKnowledge"]).toBeUndefined();
      expect(tools["getPlatformCapabilities"]).toBeUndefined();
      expect(tools["knowledge_search"]).toBeUndefined();
      expect(tools["searchKnowledge"]).toBeUndefined();

      const discovered = makeDiscoveredPlatformTools({
        dispatch: handlerDispatch(),
        resolveActingLogin: () => "knowledge-suite",
        sql: new MockSqlStorage(),
      });
      const ensured = await discovered.ensure();
      expect(ensured.ready).toBe(true);
      const discoveredTools = discovered.aiTools();
      expect(discoveredTools["tool_openaimp_query_platform_knowledge"]).toBeDefined();
      expect(discoveredTools["tool_openaimp_knowledge_search"]).toBeDefined();
    });
  });
});
