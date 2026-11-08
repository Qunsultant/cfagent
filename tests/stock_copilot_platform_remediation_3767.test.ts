import { describe, it, expect, vi } from "vitest";
import {
  remediatePlatformGaps,
} from "../src/services/stockCopilotIntrospection";
import {
  STOCK_COPILOT_MCP_STEERING,
  buildOrchestratorSystemPrompt,
} from "../src/agents/chatPrompt";
import {
  GetPaymentBudgetCommand,
  StockCopilotRemediateGapsCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MESH_TOOL_FAMILIES } from "../src/agents/registry";

describe("Issue #3767 / #3768 / #3769 — Platform Architecture Grounding & Autonomous Remediation", () => {
  describe("Sub-Issue #3767: Platform Architecture Grounding (No Kafka Invariant)", () => {
    it("STOCK_COPILOT_MCP_STEERING contains explicit Cloudflare DO/Queues runtime invariant forbidding Kafka", () => {
      expect(STOCK_COPILOT_MCP_STEERING).toContain("ARCHITECTURAL RUNTIME INVARIANT");
      expect(STOCK_COPILOT_MCP_STEERING).toContain("Cloudflare Workers, Durable Objects (DO-SQLite), D1, KV, and Cloudflare Queues");
      expect(STOCK_COPILOT_MCP_STEERING).toContain("There is NO Kafka, RabbitMQ, Celery, SQS, or Redis");
      expect(STOCK_COPILOT_MCP_STEERING).toContain("Never hallucinate Kafka");
    });

    it("STOCK_COPILOT_MCP_STEERING advertises the gap remediation tool", () => {
      expect(STOCK_COPILOT_MCP_STEERING).toContain("tool_openaimp_stock_copilot_remediate_gaps");
    });

    it("steers activated Stock Copilot turns with the grounding invariant", () => {
      const prompt = buildOrchestratorSystemPrompt({
        route: { agent: "trading", confidence: 1, reason: "Stock Copilot turn" },
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
        stockCopilotMcpActive: true,
      });

      expect(prompt).toContain("tool_openaimp_stock_copilot_remediate_gaps");
      expect(prompt).toContain("There is NO Kafka");
    });
  });

  describe("Sub-Issue #3768: Payment Budget Tool Availability (tool_openaimp_get_payment_budget)", () => {
    it("GetPaymentBudgetCommand is registered with correct permissions and schema", () => {
      const cmd = new GetPaymentBudgetCommand();
      expect(cmd.name).toBe("get_payment_budget");
      expect(MCP_TOOL_SCOPES["get_payment_budget"]).toBe("mcp:payments");

      // Verify registry contains get_payment_budget
      const g1Commands = MESH_TOOL_FAMILIES.find((r) => r.name === "Mesh door MCP commands (G1)");
      expect(g1Commands?.commands).toContain("get_payment_budget");
    });

    it("GetPaymentBudgetCommand executes and calls checkPaymentBudgetViaDoor with default or custom parameters", async () => {
      const cmd = new GetPaymentBudgetCommand();
      const mockEnv = {
        PAYMENTS_AGENT: {
          idFromName: vi.fn(() => ({})),
          get: vi.fn(() => ({
            budgetCheck: vi.fn(async () => ({
              allowed: true,
              agentId: "test_payments_agent",
            })),
          })),
        },
      };

      const auditMock = vi.fn();
      const context = {
        env: mockEnv as any,
        actingLogin: () => "trader_test",
        audit: auditMock,
      };

      const res = await cmd.execute({}, context as any);
      expect(res.allowed).toBe(true);
      expect(auditMock).toHaveBeenCalledWith("get_payment_budget", "mcp", expect.objectContaining({
        actingLogin: "trader_test",
        operation: "paid_options_screener",
        amountCents: 5,
        allowed: true,
      }));
    });
  });

  describe("Sub-Issue #3769: Autonomous Platform Gap Remediation (remediatePlatformGaps)", () => {
    it("remediatePlatformGaps runs all 4 remediation phases successfully", async () => {
      const result = await remediatePlatformGaps({
        userLogin: "trader_test",
        readSettingRaw: () => null,
      });

      expect(result.remediated).toBe(true);
      expect(result.actions.length).toBe(4);

      // 1. Pipeline chain action
      const pipelineAction = result.actions.find((a) => a.action === "run_pipeline_chain");
      expect(pipelineAction).toBeDefined();
      expect(pipelineAction?.status).toBe("success");
      expect(pipelineAction?.details).toContain("validated across all 5 stages");

      // 2. Job stagnation action
      const jobAction = result.actions.find((a) => a.action === "resolve_job_stagnation");
      expect(jobAction).toBeDefined();
      expect(jobAction?.status).toBe("success");

      // 3. Payment budget verification
      const paymentAction = result.actions.find((a) => a.action === "verify_payment_budget");
      expect(paymentAction).toBeDefined();
      expect(paymentAction?.status).toBe("success");
      expect(paymentAction?.details).toContain("tool_openaimp_get_payment_budget");

      // 4. Scheduled task assurance
      const scheduleAction = result.actions.find((a) => a.action === "configure_scheduled_goals");
      expect(scheduleAction).toBeDefined();
      expect(scheduleAction?.status).toBe("success");

      // Architecture grounding confirms zero Kafka
      expect(result.architectureGrounding).toContain("Zero external message broker dependency (no Kafka, RabbitMQ, Celery, SQS, or Redis)");
      expect(result.summary).toContain("Platform Gaps Remediation Report");
    });

    it("StockCopilotRemediateGapsCommand is registered with mcp:write and executes via MCP context", async () => {
      const cmd = new StockCopilotRemediateGapsCommand();
      expect(cmd.name).toBe("stock_copilot_remediate_gaps");
      expect(MCP_TOOL_SCOPES["stock_copilot_remediate_gaps"]).toBe("mcp:write");

      const g1Commands = MESH_TOOL_FAMILIES.find((r) => r.name === "Mesh door MCP commands (G1)");
      expect(g1Commands?.commands).toContain("stock_copilot_remediate_gaps");

      const auditMock = vi.fn();
      const context = {
        env: {} as any,
        actingLogin: () => "trader_test",
        audit: auditMock,
      };

      const result = await cmd.execute({}, context as any);
      expect(result.remediated).toBe(true);
      expect(auditMock).toHaveBeenCalledWith("stock_copilot_remediate_gaps", "mcp", expect.objectContaining({
        actingLogin: "trader_test",
        remediated: true,
      }));
    });
  });
});
