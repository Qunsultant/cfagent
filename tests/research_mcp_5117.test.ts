import { describe, expect, it } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  DefinePipelineChainCommand,
  RunResearchJobCommand,
} from "../src/mcps/openaimp/researchJobCommands";
import { codedMessage } from "../src/outcomes/outcomeAspects";

describe("Issue #5117 (Sub-issue 5 of #5109) — Research MCP Endpoints", () => {
  it("registers run_research_job and define_pipeline_chain in McpToolFactory", () => {
    expect(McpToolFactory.getTool("run_research_job")).toBeDefined();
    expect(McpToolFactory.getTool("define_pipeline_chain")).toBeDefined();
  });

  it("executes run_research_job (full run & per-stage) and define_pipeline_chain with acting identity", async () => {
    const runCmd = new RunResearchJobCommand();
    const ctx = {
      actingLogin: () => "trader@example.com",
      audit: () => {},
      env: {},
    } as any;

    const full = await runCmd.execute({ trigger: "manual", runId: "r-mcp-1" }, ctx);
    expect((full as any).engineJobId).toBe("research:r-mcp-1");

    const stage = await runCmd.execute(
      { runId: "r-mcp-1", stageId: "evaluate", op: "run" },
      ctx,
    );
    expect(stage).toMatchObject({
      ok: true,
      engineJobId: "research:r-mcp-1",
      stageId: "evaluate",
      op: "run",
    });

    await expect(
      runCmd.execute({ trigger: "manual" }, { actingLogin: () => undefined, audit: () => {}, env: {} } as any),
    ).rejects.toThrow(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));

    const defineCmd = new DefinePipelineChainCommand();
    const defined = await defineCmd.execute(
      {
        jobId: "research-custom-chain",
        stages: ["feed", "enrich", "analyze", "generate", "deliver", "evaluate"],
      },
      ctx,
    );
    expect(defined).toMatchObject({
      ok: true,
      jobId: "research-custom-chain",
      owner: "trader@example.com",
    });
  });
});
