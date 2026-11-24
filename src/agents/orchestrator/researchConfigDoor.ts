/** Issue #5976 — the chat/MCP config door: one owner, no second store. */
import type { ResearchConfig } from "../../services/researchConfig";
import type { ResearchAgent } from "../research-agent";

export async function readResearchConfig(
  agent: ResearchAgent | null,
): Promise<Record<string, unknown>> {
  if (!agent) {
    throw new Error(
      "research_agent_unavailable: the acting login has no research agent, so the configuration cannot be read.",
    );
  }
  return (await agent.getResearchConfig()) as unknown as Record<string, unknown>;
}

export async function writeResearchConfig(
  agent: ResearchAgent | null,
  patch: Record<string, unknown>,
): Promise<{ config: Record<string, unknown>; errors: string[] }> {
  if (!agent) {
    throw new Error(
      "research_agent_unavailable: the acting login has no research agent, so the configuration cannot be saved.",
    );
  }
  const result = await agent.saveConfig(patch as Partial<ResearchConfig>);
  return {
    config: result.config as unknown as Record<string, unknown>,
    errors: result.errors,
  };
}
