/**
 * Issue #2171 (parent #1717) — agent-grant enforcement at the MCP
 * tool gate (the #1744 choke point), behind the platform-only
 * IAAA_AGENT_ACCESS_MODE switch.
 *
 * RED FIRST: written against the `agentAccess` option on
 * authorizeMcpToolCall / executeWithPermissionGate before it
 * exists. Without the option, behavior is byte-identical to the
 * pre-#2171 gate (scope check only); with it, mode=off changes
 * nothing, mode=audit shadows (audits would-deny, never denies),
 * and mode=enforce denies before execution begins.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpAgentToolAdapter } from "../src/agents/mcpAdapter";
import type { McpToolContext } from "../src/patterns/interfaces";
import { BusinessError } from "../src/outcomes/outcomeAspects";
import {
  MCP_PERMISSION_DENIED_CODE,
  createInMemoryMcpPermissionPort,
  executeWithPermissionGate,
  type McpPrincipal,
  type McpScope,
} from "../src/mcps/openaimp/mcpPermissionPorts";
import {
  createAgentGrant,
  createAgentIdentity,
  createMemoryAgentGrantStore,
  createMemoryAgentIdentityStore,
  revokeAgentGrant,
  type AgentAccessDeps,
} from "../src/security/agentAccess";

const NOW = 1_800_000_000_000;
const TENANT = "tenant-1";
const AGENT_ID = "agent:mcp:turn";
const FULL_PORT = createInMemoryMcpPermissionPort();
const READ_ONLY_PORT = createInMemoryMcpPermissionPort({
  overrides: new Map<string, readonly McpScope[]>([["api-key:reader", ["mcp:read"]]]),
});
const AGENT_TURN: McpPrincipal = { kind: "agent-turn", login: null };
const READER_KEY: McpPrincipal = { kind: "api-key", login: "reader" };

async function agentStores(opts: { grantTarget?: string; revoke?: boolean } = {}) {
  const identities = createMemoryAgentIdentityStore();
  const grants = createMemoryAgentGrantStore();
  const identity = await createAgentIdentity(identities, {
    kind: "mcp",
    slug: "turn",
    tenantId: TENANT,
    nowMs: NOW,
  });
  if (!identity.ok) throw new Error("gate identity setup failed");
  const grant = await createAgentGrant(identities, grants, undefined, {
    agentId: AGENT_ID,
    targetKind: "tool",
    target: opts.grantTarget ?? "web_search",
    tenantId: TENANT,
    resourceScope: [],
    nowMs: NOW,
  });
  if (!grant.ok) throw new Error("gate grant setup failed");
  if (opts.revoke) await revokeAgentGrant(grants, grant.grant.id, NOW);
  const deps: AgentAccessDeps = { identities, grants };
  return { identities, grants, grant: grant.grant, deps };
}

describe("agent access at the MCP gate (#2171)", () => {
  it("without agentAccess the gate is unchanged: scope allow executes", async () => {
    const run = vi.fn().mockResolvedValue("ran");
    const out = await executeWithPermissionGate({
      port: FULL_PORT,
      principal: AGENT_TURN,
      toolName: "web_search",
      audit: vi.fn(),
      run,
    });
    expect(out).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("mode=off changes nothing even when the grant would deny", async () => {
    const { deps } = await agentStores({ grantTarget: "other_tool" });
    const run = vi.fn().mockResolvedValue("ran");
    const out = await executeWithPermissionGate({
      port: FULL_PORT,
      principal: AGENT_TURN,
      toolName: "web_search",
      audit: vi.fn(),
      agentAccess: { mode: "off", deps, agentId: AGENT_ID, tenantId: TENANT, nowMs: NOW },
      run,
    });
    expect(out).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("mode=audit shadows: would-deny executes, shadow denial audited", async () => {
    const { deps } = await agentStores({ grantTarget: "other_tool" });
    const audit = vi.fn();
    const run = vi.fn().mockResolvedValue("ran");
    const out = await executeWithPermissionGate({
      port: FULL_PORT,
      principal: AGENT_TURN,
      toolName: "web_search",
      audit,
      agentAccess: { mode: "audit", deps, agentId: AGENT_ID, tenantId: TENANT, nowMs: NOW },
      run,
    });
    expect(out).toBe("ran");
    expect(audit).toHaveBeenCalledWith(
      "agent.access_shadow_denied",
      "mcp",
      expect.objectContaining({ tool: "web_search", reason: "NO_GRANT" }),
    );
  });

  it("mode=enforce denies before execution and audits the denial", async () => {
    const { deps } = await agentStores({ revoke: true });
    const audit = vi.fn();
    const run = vi.fn().mockResolvedValue("should-not-run");
    await expect(
      executeWithPermissionGate({
        port: FULL_PORT,
        principal: AGENT_TURN,
        toolName: "web_search",
        audit,
        agentAccess: { mode: "enforce", deps, agentId: AGENT_ID, tenantId: TENANT, nowMs: NOW },
        run,
      }),
    ).rejects.toMatchObject({ name: "BusinessError", code: MCP_PERMISSION_DENIED_CODE });
    expect(run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "agent.access_denied",
      "mcp",
      expect.objectContaining({ tool: "web_search", reason: "GRANT_REVOKED", agentId: AGENT_ID }),
    );
  });

  it("mode=enforce allows with a valid grant, audits the action, consumes budget", async () => {
    const { deps, grants, grant } = await agentStores();
    const audit = vi.fn();
    const run = vi.fn().mockResolvedValue("ran");
    const out = await executeWithPermissionGate({
      port: FULL_PORT,
      principal: AGENT_TURN,
      toolName: "web_search",
      audit,
      agentAccess: { mode: "enforce", deps, agentId: AGENT_ID, tenantId: TENANT, nowMs: NOW },
      run,
    });
    expect(out).toBe("ran");
    expect(audit).toHaveBeenCalledWith(
      "agent.action",
      "mcp",
      expect.objectContaining({ tool: "web_search", grantId: grant.id, decision: "allow" }),
    );
    const stored = await grants.get(grant.id);
    expect(stored?.usedActions).toBe(1);
  });

  it("a scope denial still wins before any agent check", async () => {
    const { deps } = await agentStores();
    const audit = vi.fn();
    const run = vi.fn().mockResolvedValue("should-not-run");
    await expect(
      executeWithPermissionGate({
        port: READ_ONLY_PORT,
        principal: READER_KEY,
        toolName: "draft_payment",
        audit,
        agentAccess: { mode: "enforce", deps, agentId: AGENT_ID, tenantId: TENANT, nowMs: NOW },
        run,
      }),
    ).rejects.toMatchObject({ name: "BusinessError", code: MCP_PERMISSION_DENIED_CODE });
    expect(run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "mcp.permission_denied",
      "mcp",
      expect.objectContaining({ tool: "draft_payment" }),
    );
    expect(audit.mock.calls.some((c) => String(c[0]).startsWith("agent."))).toBe(false);
  });
});

describe("agent access through the agent-turn adapter (#2171)", () => {
  function adaptedTool(deps: AgentAccessDeps, mode: "enforce") {
    const command = {
      name: "web_search",
      description: "stub",
      zodSchema: z.object({}),
      execute: async () => "ran",
    };
    const context = {
      permissionPort: FULL_PORT,
      principal: AGENT_TURN,
      audit: vi.fn(),
      agentAccess: { mode, deps, agentId: AGENT_ID, tenantId: TENANT, nowMs: NOW },
    } as unknown as McpToolContext;
    const adapted = McpAgentToolAdapter.adapt(command as never, context);
    return { adapted, audit: context.audit as unknown as ReturnType<typeof vi.fn> };
  }

  it("adapter enforce-deny blocks the command; enforce-allow runs it", async () => {
    const denied = await agentStores({ revoke: true });
    const { adapted: deniedTool } = adaptedTool(denied.deps, "enforce");
    await expect(
      (deniedTool as unknown as { execute: (input: unknown) => Promise<unknown> }).execute({}),
    ).rejects.toMatchObject({ name: "BusinessError", code: MCP_PERMISSION_DENIED_CODE });

    const allowed = await agentStores();
    const { adapted: allowedTool } = adaptedTool(allowed.deps, "enforce");
    const out = await (
      allowedTool as unknown as { execute: (input: unknown) => Promise<unknown> }
    ).execute({});
    expect(out).toBe("ran");
  });
});
