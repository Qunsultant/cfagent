/**
 * Issue #2417 (Agent Mesh S14, programme #2225 G11) — tool registry
 * completion: every tool family's recorded status is pinned against
 * the evidence the status rests on.
 *
 * S1's suite (tests/mesh_registry_s1_2322.test.ts) pins the
 * registry's shape: family list, command accounting against the live
 * McpToolFactory catalog, and the MAS tool set. This suite pins the
 * STATUSES — the G11 claim. A status is only as honest as the fact
 * under it, so each non-live status is pinned to that fact:
 *
 *   - sandbox-tools is "degraded" BECAUSE both construction sites
 *     pass no container and wrangler.jsonc declares no containers
 *     configuration, so ETradeSandboxService returns executed:false.
 *     Bind a backend (the owner decision the registry notes name)
 *     and these pins fail until the status is updated in the same PR.
 *   - ai-search-platform is "degraded" BECAUSE the
 *     ai_search_namespaces binding is not declared in wrangler.jsonc
 *     (the namespace value is dashboard-issued; src/types.ts records
 *     the owner enablement steps).
 *   - durable-fibers is "degraded" BECAUSE its live records sit in
 *     an in-memory Map (the same fact the S4 fibers cells rest on).
 *   - web-search / web-fetch are "absent" BECAUSE no tool by either
 *     name exists in src/ or in the MCP catalog.
 *   - agent-skills is "live" (since #2705) BECAUSE exactly one
 *     agent class — OrchestratorAgent — overrides Think's
 *     getSkills() hook to serve an in-repo code-manifest source,
 *     while none of the SDK's skills tools is registered in the
 *     MCP catalog (they are turn tools, built by Think's turn
 *     assembly from the catalog). The adapter itself is present
 *     in the pinned SDK and PortThink neither overrides nor
 *     blocks it. Adopt skills on another class, remove the one
 *     override, or bump the SDK past the hook, and a pin here
 *     fails. Harness note: Node vitest aliases @cloudflare/think
 *     to a stub (#2003 — the real package's runtime graph reaches
 *     workerd-only imports), so the SDK-surface fact is pinned
 *     against the installed package's shipped type declarations —
 *     the same locked artifact the production build bundles — not
 *     against a runtime prototype this harness cannot load. The
 *     driven conformance evidence (catalog + tool factory +
 *     executed tools) lives in
 *     tests/agent_skills_enablement_s1_2705.test.ts, which loads
 *     the real agents/skills modules Think itself runs.
 *
 * Live statuses for the command families rest on S1's live catalog
 * accounting; this suite adds the evidence for the non-command live
 * families (defining module + the fact the status cites).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MESH_AGENTS,
  MESH_TOOL_FAMILIES,
  getToolFamily,
  type MeshToolFamilyStatus,
} from "../src/agents/registry";
import { McpToolFactory } from "../src/mcps/openaimp/commands";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

const wrangler = JSON.parse(stripJsonc(read("wrangler.jsonc"))) as Record<
  string,
  unknown
>;

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

/** Every src/ file except the registry itself (whose notes name the absent tools). */
const SRC_FILES = [...walkTs(resolve(root, "src"))].filter(
  (f) => !f.endsWith(join("src", "agents", "registry.ts")),
);

// ---------------------------------------------------------------------------
// The status table — the G11 record this slice completes.
// ---------------------------------------------------------------------------

const EXPECTED_STATUS: Record<string, MeshToolFamilyStatus> = {
  "core-mcp-commands": "live",
  "cloudflare-agent-mcp-commands": "live",
  "etrade-mcp-commands": "live",
  "agentic-payment-mcp-commands": "live",
  "goal-chain-mcp-commands": "live",
  "market-data-mcp-commands": "live",
  "agentdb-read-mcp-commands": "live",
  "mesh-door-mcp-commands": "live",
  "mas-tools": "live",
  "remote-mcp-servers": "live",
  "sandbox-tools": "degraded",
  "browser-tools": "live",
  "ai-search-service": "live",
  "payments-tools": "live",
  "screening-research-services": "live",
  "durable-fibers": "degraded",
  "web-search": "absent",
  "web-fetch": "absent",
  "ai-search-platform": "degraded",
  "agent-skills": "live",
};

describe("tool family status table (#2417)", () => {
  it("records exactly the 20 expected families, no more, no fewer", () => {
    expect(MESH_TOOL_FAMILIES.map((f) => f.id).sort()).toEqual(
      Object.keys(EXPECTED_STATUS).sort(),
    );
  });

  it("every family's recorded status equals the pinned status", () => {
    for (const family of MESH_TOOL_FAMILIES) {
      expect(family.status, family.id).toBe(EXPECTED_STATUS[family.id]);
    }
  });

  it("every family carrying McpToolFactory commands is live (the catalog is the evidence)", () => {
    const catalog = new Set(McpToolFactory.getAllTools().map((t) => t.name));
    for (const family of MESH_TOOL_FAMILIES) {
      if (family.commands.length === 0) continue;
      expect(family.status, family.id).toBe("live");
      for (const command of family.commands) {
        expect(catalog.has(command), `${family.id}:${command}`).toBe(true);
      }
    }
  });

  it("every non-live family states its degradation or absence in its notes", () => {
    for (const family of MESH_TOOL_FAMILIES) {
      if (family.status === "live") continue;
      expect((family.notes ?? "").length, family.id).toBeGreaterThan(80);
    }
  });
});

// ---------------------------------------------------------------------------
// Degraded evidence
// ---------------------------------------------------------------------------

describe("degraded status evidence (#2417)", () => {
  it("sandbox-tools: no container is bound at either construction site, no containers config exists, and the service's no-backend path returns executed:false", () => {
    // The agent and the MCP facade both construct the service with
    // the container argument literally undefined (the survey §8 fact,
    // still true on current main).
    expect(read("src/agents/sandbox-agent.ts")).toContain(
      "new ETradeSandboxService(undefined",
    );
    expect(read("src/mcps/openaimp/cloudflareAgentCommands.ts")).toContain(
      "new ETradeSandboxService(undefined",
    );
    // wrangler.jsonc declares no Cloudflare Containers configuration.
    expect(wrangler["containers"]).toBeUndefined();
    // With no container bound, the service honestly does not execute.
    const service = read("src/services/sandboxAgent.ts");
    expect(service).toContain("executed: false");
    expect(service).toContain("no container sandbox backend is bound");
  });

  it("durable-fibers: live records sit in an in-memory Map — not durable across eviction", () => {
    expect(read("src/services/durableFibers.ts")).toContain(
      "activeFibers = new Map",
    );
  });

  it("ai-search-platform: the ai_search_namespaces binding is not declared in wrangler.jsonc, and the env type records it as owner-added config", () => {
    expect(wrangler["ai_search_namespaces"]).toBeUndefined();
    expect(read("src/types.ts")).toContain("AI_SEARCH?: AiSearchNamespace");
    // The three-path runner the agent degrades through exists.
    expect(existsSync(resolve(root, "src/agents/aiSearchPaths.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Absent evidence
// ---------------------------------------------------------------------------

describe("absent status evidence (#2417)", () => {
  it("web-search / web-fetch: no tool by either name exists in src/ or in the MCP catalog", () => {
    const catalog = new Set(McpToolFactory.getAllTools().map((t) => t.name));
    expect(catalog.has("web_search")).toBe(false);
    expect(catalog.has("web_fetch")).toBe(false);
    for (const file of SRC_FILES) {
      const src = readFileSync(file, "utf8");
      expect(src.includes('"web_search"'), file).toBe(false);
      expect(src.includes('"web_fetch"'), file).toBe(false);
    }
  });

  it("agent-skills: the family records the SDK's three tool names, none of them registered in the MCP catalog (they are turn tools)", () => {
    const family = getToolFamily("agent-skills");
    expect(family).toBeDefined();
    expect(family!.status).toBe("live");
    expect([...(family!.toolNames ?? [])].sort()).toEqual(
      ["activate_skill", "read_skill_resource", "run_skill_script"].sort(),
    );
    const catalog = new Set(McpToolFactory.getAllTools().map((t) => t.name));
    for (const name of family!.toolNames ?? []) {
      expect(catalog.has(name), name).toBe(false);
    }
  });

  it("agent-skills: exactly one agent class overrides getSkills() — OrchestratorAgent (#2705); the hook lives in exactly two src files", () => {
    for (const agent of MESH_AGENTS) {
      const has = read(agent.sourceFile).includes("getSkills");
      expect(has, agent.className).toBe(agent.className === "OrchestratorAgent");
    }
    const withHook = SRC_FILES.filter((file) =>
      readFileSync(file, "utf8").includes("getSkills"),
    )
      .map((file) => file.slice(root.length + 1).replace(/\\/g, "/"))
      .sort();
    expect(withHook).toEqual([
      "src/agents/orchestrator.ts",
      "src/agents/orchestrator/skillPacks.ts",
    ]);
  });

  it("agent-skills: the adapter the family record cites is present in the pinned SDK, and PortThink neither overrides nor blocks it", () => {
    // package.json pins @cloudflare/think, and the installed
    // package's shipped type declarations expose the getSkills()
    // hook returning SkillSource[] — the adapter exists in the SDK
    // the production build bundles. A future SDK bump that removes
    // or renames the hook must re-write the registry record, so
    // this fails then. (Runtime-prototype pinning is not available:
    // Node vitest aliases the package to a stub, #2003.)
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@cloudflare/think"]).toBeDefined();
    const distDir = resolve(root, "node_modules/@cloudflare/think/dist");
    const declarations = readdirSync(distDir)
      .filter((f) => f.endsWith(".d.ts"))
      .map((f) => readFileSync(join(distDir, f), "utf8"))
      .join("\n");
    expect(declarations).toContain("getSkills(): SkillSource[]");
    // PortThink (the actor port every fleet agent extends) does not
    // shadow the hook: adoption is a per-class override away, and
    // the port does not expose skill sources itself.
    expect(read("src/actors/thinkAdapter.ts")).not.toContain("getSkills");
  });
});

// ---------------------------------------------------------------------------
// Live evidence for the non-command families
// ---------------------------------------------------------------------------

describe("live status evidence — non-command families (#2417)", () => {
  it("browser-tools: the BROWSER binding is declared in wrangler.jsonc (the #2253 fact that retired the survey-era degraded record)", () => {
    expect(
      (wrangler["browser"] as { binding?: string } | undefined)?.binding,
    ).toBe("BROWSER");
  });

  it("remote-mcp-servers: both outbound clients the family records exist — RemoteMcpClient and PublicMcpClient", () => {
    expect(read("src/mcps/client/mcpClient.ts")).toContain("RemoteMcpClient");
    expect(read("src/mcps/public/publicMcp.ts")).toContain(
      "class PublicMcpClient",
    );
    const family = getToolFamily("remote-mcp-servers");
    expect(family!.source).toContain("publicMcp");
  });

  it("ai-search-service: the REST service exists, and its labelled in-repo fallback is the one the family notes record", () => {
    const service = read("src/services/aiSearch.ts");
    expect(service).toContain("ETradeAISearchService");
    expect(service).toContain("FINANCIAL_KNOWLEDGE_BASE");
    expect(service).toContain('"semantic_cache"');
    expect(getToolFamily("ai-search-service")!.notes ?? "").toContain(
      "semantic_cache",
    );
    // The instance endpoint the primary path runs against is
    // configured in wrangler vars.
    expect(
      (wrangler["vars"] as Record<string, unknown>)["AI_SEARCH_ENDPOINT"],
    ).toBeDefined();
  });

  it("core-mcp-commands: the notes record the platform-knowledge grounding the survey §8 caveat requires", () => {
    expect(getToolFamily("core-mcp-commands")!.notes ?? "").toContain(
      "platformKnowledge",
    );
    expect(read("src/mcps/openaimp/commands.ts")).toContain("searchPlatformKnowledge");
  });

  it("payments-tools and screening-research-services: their defining modules exist", () => {
    expect(existsSync(resolve(root, "src/services/payments.ts"))).toBe(true);
    expect(existsSync(resolve(root, "src/agents/payments-agent.ts"))).toBe(true);
    expect(existsSync(resolve(root, "src/agents/screener-agent.ts"))).toBe(true);
    expect(existsSync(resolve(root, "src/agents/research-agent.ts"))).toBe(true);
  });
});
