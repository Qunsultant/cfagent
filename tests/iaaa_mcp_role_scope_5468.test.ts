/**
 * GAP-4 (#5468) — the IAAA role→scope adapter plugged into the ADR
 * 0012 seam: scopes derive from IAAA roles through the permission
 * correspondence, read off the compiled policy snapshot. The
 * correspondence is a proposal put to CISO review (#5350), not a
 * CISO decision; these tests pin the derivation as proposed, the
 * kind pins, the defaults-remain fallback, and the regression
 * that bare ports behave exactly as before.
 */
import { describe, it, expect, vi } from "vitest";
import { getCompiledPolicySnapshot, type Role } from "../src/security/authorization";
import {
  MCP_PERMISSION_DENIED_CODE,
  MCP_SCOPES,
  createInMemoryMcpPermissionPort,
  createProductionMcpPermissionPort,
  defaultScopesForKind,
  executeWithPermissionGate,
  resolveScopesWithRoleAdapter,
  scopesForIaaaRoles,
  type McpPrincipal,
  type McpRoleResolver,
} from "../src/mcps/openaimp/mcpPermissionPorts";

const MEMBER: McpPrincipal = { kind: "session", login: "alice" };
const ADMIN: McpPrincipal = { kind: "session", login: "carol" };
const SCANNER: McpPrincipal = { kind: "scanner-payment", login: null };
const UNKNOWN: McpPrincipal = { kind: "unknown", login: null };
const SYSTEM: McpPrincipal = { kind: "system", login: null };

/** Stub resolver: alice is a member, carol a tenant-admin, everyone else unresolvable. */
const stubResolver: McpRoleResolver = (principal) => {
  if (principal.login === "alice") return ["member"];
  if (principal.login === "carol") return ["tenant-admin"];
  return null;
};

describe("role→scope derivation (#5468)", () => {
  it("derives each role's scopes from its grants under the proposed correspondence", () => {
    expect(scopesForIaaaRoles(["member"])).toEqual(["mcp:read", "mcp:write"]);
    expect(scopesForIaaaRoles(["approver"])).toEqual([]);
    expect(scopesForIaaaRoles(["auditor"])).toEqual(["mcp:read", "mcp:admin"]);
    expect(scopesForIaaaRoles(["tenant-admin"])).toEqual([...MCP_SCOPES]);
    expect(scopesForIaaaRoles(["workspace-admin"])).toEqual([...MCP_SCOPES]);
    expect(scopesForIaaaRoles(["platform-admin"])).toEqual(["mcp:admin"]);
  });

  it("unions scopes across roles", () => {
    expect(scopesForIaaaRoles(["member", "auditor"])).toEqual([
      "mcp:read",
      "mcp:write",
      "mcp:admin",
    ]);
  });

  it("holds nothing for an empty role set or an unknown role (fail-closed)", () => {
    expect(scopesForIaaaRoles([])).toEqual([]);
    expect(scopesForIaaaRoles(["bogus-role" as unknown as Role])).toEqual([]);
    expect(scopesForIaaaRoles(["member", "bogus-role" as unknown as Role])).toEqual([
      "mcp:read",
      "mcp:write",
    ]);
  });

  it("follows the compiled snapshot, not a copied table", () => {
    const snapshot = getCompiledPolicySnapshot();
    const extended = {
      ...snapshot,
      roleGrants: {
        ...snapshot.roleGrants,
        member: [...snapshot.roleGrants["member"], "ledger:record" as const],
      },
    };
    expect(scopesForIaaaRoles(["member"], extended)).toEqual([
      "mcp:read",
      "mcp:write",
      "mcp:payments",
    ]);
    // The live snapshot is untouched by the pinned derivation above.
    expect(scopesForIaaaRoles(["member"])).toEqual(["mcp:read", "mcp:write"]);
  });

  it("derives mcp:payments from ledger:record only", () => {
    expect(scopesForIaaaRoles(["member"])).not.toContain("mcp:payments");
    expect(scopesForIaaaRoles(["tenant-admin"])).toContain("mcp:payments");
    expect(scopesForIaaaRoles(["platform-admin"])).not.toContain("mcp:payments");
  });
});

describe("adapter resolution (#5468)", () => {
  it("pins scanner-payment to mcp:payments with or without a resolver", async () => {
    expect(await resolveScopesWithRoleAdapter(SCANNER)).toEqual(["mcp:payments"]);
    expect(await resolveScopesWithRoleAdapter(SCANNER, stubResolver)).toEqual(["mcp:payments"]);
    expect(await resolveScopesWithRoleAdapter(SCANNER)).toEqual(
      defaultScopesForKind("scanner-payment"),
    );
  });

  it("denies unknown principals with or without a resolver", async () => {
    expect(await resolveScopesWithRoleAdapter(UNKNOWN)).toEqual([]);
    expect(await resolveScopesWithRoleAdapter(UNKNOWN, stubResolver)).toEqual([]);
    expect(await resolveScopesWithRoleAdapter(UNKNOWN)).toEqual(defaultScopesForKind("unknown"));
  });

  it("never governs system principals: defaults remain even with a resolver", async () => {
    expect(await resolveScopesWithRoleAdapter(SYSTEM)).toBeNull();
    expect(await resolveScopesWithRoleAdapter(SYSTEM, stubResolver)).toBeNull();
    expect(
      await resolveScopesWithRoleAdapter(SYSTEM, () => ["tenant-admin"]),
    ).toBeNull();
  });

  it("returns null where roles are unresolvable, so the defaults remain", async () => {
    expect(await resolveScopesWithRoleAdapter(MEMBER)).toBeNull();
    expect(await resolveScopesWithRoleAdapter(MEMBER, () => null)).toBeNull();
    expect(await resolveScopesWithRoleAdapter({ kind: "api-key", login: "nobody" }, stubResolver)).toBeNull();
  });

  it("derives role scopes when the resolver returns roles, sync or async", async () => {
    expect(await resolveScopesWithRoleAdapter(MEMBER, stubResolver)).toEqual([
      "mcp:read",
      "mcp:write",
    ]);
    expect(await resolveScopesWithRoleAdapter(ADMIN, stubResolver)).toEqual([...MCP_SCOPES]);
    expect(await resolveScopesWithRoleAdapter(MEMBER, async () => ["auditor"])).toEqual([
      "mcp:read",
      "mcp:admin",
    ]);
  });
});

describe("role-based ports (#5468)", () => {
  it("production port with a resolver enforces role-derived scopes", async () => {
    const port = createProductionMcpPermissionPort({ resolveRoles: stubResolver });
    expect(await port.scopesFor(MEMBER)).toEqual(["mcp:read", "mcp:write"]);
    expect(await port.scopesFor(ADMIN)).toEqual([...MCP_SCOPES]);
    expect(await port.authorize(MEMBER, "etrade_get_quote")).toMatchObject({
      allowed: true,
      scope: "mcp:read",
    });
    const denied = await port.authorize(MEMBER, "draft_payment");
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe("mcp:payments");
    const tradeDenied = await port.authorize(MEMBER, "alpaca_place_order");
    expect(tradeDenied.allowed).toBe(false);
    expect(tradeDenied.scope).toBe("mcp:trade");
  });

  it("production port with a resolver falls back to defaults where roles do not resolve", async () => {
    const port = createProductionMcpPermissionPort({ resolveRoles: stubResolver });
    const scopes = await port.scopesFor({ kind: "api-key", login: "nobody" });
    expect(new Set(scopes)).toEqual(new Set(MCP_SCOPES));
    expect(await port.scopesFor(SYSTEM)).toEqual([...MCP_SCOPES]);
  });

  it("in-memory port precedence: overrides beat the adapter, the adapter beats defaults", async () => {
    const port = createInMemoryMcpPermissionPort({
      overrides: { "session:alice": ["mcp:read"] },
      resolveRoles: stubResolver,
    });
    expect(await port.scopesFor(MEMBER)).toEqual(["mcp:read"]);
    expect(await port.scopesFor(ADMIN)).toEqual([...MCP_SCOPES]);
    expect(await port.scopesFor({ kind: "session", login: "nobody" })).toEqual([
      ...MCP_SCOPES,
    ]);
  });

  it("gate denies an out-of-scope role-derived call with the coded error + audit, before execution", async () => {
    const port = createProductionMcpPermissionPort({ resolveRoles: stubResolver });
    const run = vi.fn().mockResolvedValue("should-not-run");
    const audit = vi.fn();
    await expect(
      executeWithPermissionGate({
        port,
        principal: MEMBER,
        toolName: "draft_payment",
        sessionId: "session_1",
        audit,
        run,
      }),
    ).rejects.toMatchObject({ name: "BusinessError", code: MCP_PERMISSION_DENIED_CODE });
    expect(run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "mcp.permission_denied",
      "mcp",
      expect.objectContaining({ tool: "draft_payment", requiredScope: "mcp:payments" }),
    );
  });

  it("gate allows an in-scope role-derived call unchanged", async () => {
    const port = createProductionMcpPermissionPort({ resolveRoles: stubResolver });
    const out = await executeWithPermissionGate({
      port,
      principal: MEMBER,
      toolName: "etrade_get_quote",
      sessionId: "session_1",
      audit: vi.fn(),
      run: async () => "ran",
    });
    expect(out).toBe("ran");
  });
});

describe("regression: bare ports keep the recorded defaults (#5468)", () => {
  it("bare production port holds every scope for interactive kinds, pin for scanner, none for unknown", async () => {
    const port = createProductionMcpPermissionPort();
    for (const principal of [
      SYSTEM,
      MEMBER,
      { kind: "api-key", login: "alice" },
      { kind: "agent-turn", login: null },
    ] as McpPrincipal[]) {
      expect(new Set(await port.scopesFor(principal))).toEqual(new Set(MCP_SCOPES));
    }
    expect(await port.scopesFor(SCANNER)).toEqual(["mcp:payments"]);
    expect(await port.scopesFor(UNKNOWN)).toEqual([]);
  });

  it("bare in-memory port matches the bare production port", async () => {
    const port = createInMemoryMcpPermissionPort();
    expect(new Set(await port.scopesFor(MEMBER))).toEqual(new Set(MCP_SCOPES));
    expect(await port.scopesFor(SCANNER)).toEqual(["mcp:payments"]);
    expect(await port.scopesFor(UNKNOWN)).toEqual([]);
  });
});
