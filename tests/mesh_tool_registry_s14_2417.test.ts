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
 *   - ai-search-platform is "degraded" BECAUSE, although the
 *     ai_search_namespaces binding is now declared in wrangler.jsonc
 *     (namespace "default", owner-provided under #1169; src/types.ts
 *     records the landed enablement), the namespace path has not yet
 *     been verified end-to-end — the #1169 seed+probe step is what
 *     retires the degradation.
 *   - durable-fibers is "degraded" BECAUSE its live records sit in
 *     an in-memory Map (the same fact the S4 fibers cells rest on)
 *     and checkpoint read-back (#2763) covers only runs that carry
 *     a runId.
 *   - web-search is "live" (since #3935, on #2731's command) BECAUSE
 *     the web_search command IS registered in the catalog AND the
 *     provider seam (src/services/webSearch.ts) now carries a
 *     provider chain, free/keyless first: the keyless DuckDuckGo
 *     provider answers with no configuration at all, so the backend
 *     is no longer config-gated off. It was "degraded" from #2731
 *     to #3935, when the only provider needed a BRAVE_SEARCH_API_KEY
 *     secret this deployment never had. The named failures are now
 *     the empty-chain (web_search_provider_not_configured) and
 *     exhausted-chain (web_search_all_providers_failed) errors,
 *     pinned below.
 *   - web-fetch is "live" (since #2760, tracker #2708 A3) BECAUSE
 *     the web_fetch tool exists in the MCP catalog, defined by
 *     src/mcps/openaimp/webFetchCommands.ts over the deterministic
 *     service in src/services/webFetch.ts. Unlike web-search it
 *     has no provider or configuration gate — a plain fetch — so
 *     live is its honest status, pinned below.
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
  "web-search": "live",
  "web-fetch": "live",
  "ai-search-platform": "degraded",
  "agent-skills": "live",
  // Issue #3888: the externalized trading limits.
  "trading-limits-mcp-commands": "live",
  // Issue #3883: order cancellation (one engine, every scope).
  "order-cancel-mcp-commands": "live",
  // Issue #3990: Public.com copilot tools (quotes + orders on the
  // Public MCP transport, preview-first placement).
  "public-mcp-commands": "live",
};

describe("tool family status table (#2417)", () => {
  it("records exactly the 23 expected families, no more, no fewer", () => {
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
    // #3935 retired the one recorded exception: web-search's provider
    // chain is keyless-first, so a catalog command now implies a live
    // backend for every command-carrying family, with no carve-out.
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
  it("sandbox-tools: container is bound at SandboxAgent construction site and declared in wrangler.jsonc (#3492)", () => {
    // SandboxAgent constructs the service with the bound container (this.ctx.container).
    expect(read("src/agents/sandbox-agent.ts")).toContain(
      "new ETradeSandboxService(container",
    );
    expect(read("src/mcps/openaimp/cloudflareAgentCommands.ts")).toContain(
      "new ETradeSandboxService(undefined",
    );
    // wrangler.jsonc declares Cloudflare Containers configuration for SandboxAgent (#3492).
    expect(wrangler["containers"]).toBeDefined();
    expect(wrangler["containers"][0].class_name).toBe("SandboxAgent");
    // With no container bound (outside container runtime), the service honestly does not execute.
    const service = read("src/services/sandboxAgent.ts");
    expect(service).toContain("executed: false");
    expect(service).toContain("no container sandbox backend is bound");
  });

  it("durable-fibers: live records sit in an in-memory Map; checkpoints read back only for runId runs (#2763)", () => {
    const src = read("src/services/durableFibers.ts");
    expect(src).toContain("activeFibers = new Map");
    // The family stays "degraded": the read half exists for runs that
    // carry an identity (runId), and fails loud on untrusted state —
    // a run without a runId is still write-only.
    expect(src).toContain("loadRunCheckpoint");
    expect(src).toContain("FiberCheckpointError");
  });

  it("web-search: the command is registered, and the keyless-first chain is the recorded backend fact (#2731, #3935)", () => {
    // The surface is live: web_search is in the factory catalog.
    const catalog = new Set(McpToolFactory.getAllTools().map((t) => t.name));
    expect(catalog.has("web_search")).toBe(true);
    // The backend fact the live status rests on (#3935): a provider
    // chain, free/keyless first, whose keyless member needs no
    // configuration — and whose two named failures are the empty
    // chain and the exhausted chain.
    const service = read("src/services/webSearch.ts");
    expect(service).toContain("web_search_provider_not_configured");
    expect(service).toContain("web_search_all_providers_failed");
    expect(service).toContain("DuckDuckGoWebSearchProvider");
    expect(service).toContain("SEARXNG_BASE_URL");
    expect(service).toContain("BRAVE_SEARCH_API_KEY");
    const family = getToolFamily("web-search");
    expect(family).toBeDefined();
    expect(family!.commands).toEqual(["web_search"]);
    expect(family!.notes ?? "").toContain("free/keyless first");
    expect(family!.notes ?? "").toContain("web_search_all_providers_failed");
  });

  it("ai-search-platform: the ai_search_namespaces binding is declared in wrangler.jsonc (namespace \"default\", #1169), and the env type records it", () => {
    expect(wrangler["ai_search_namespaces"]).toEqual([
      // "binding", not "name": wrangler's schema for this binding
      // type (issue #3321 — the "name" form shipped in #3319 was
      // rejected by the production deploy).
      { binding: "AI_SEARCH", namespace: "default", remote: true },
    ]);
    expect(read("src/types.ts")).toContain("AI_SEARCH?: AiSearchNamespace");
    // The three-path runner the agent degrades through exists.
    expect(existsSync(resolve(root, "src/agents/aiSearchPaths.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Absent evidence
// ---------------------------------------------------------------------------

describe("absent status evidence (#2417)", () => {
  // No absence test remains for the two reference-set families:
  // web-search left "absent" with #2731 (registered, provider-gated
  // — its evidence is the degraded pin above) and web-fetch left
  // "absent" with #2760 (registered and live — its evidence is the
  // next test). An assertion that either tool does NOT exist would
  // now be false, so the pin's job is done by the status table.

  it("web-fetch: live since #2760 — the web_fetch tool is in the catalog and its defining modules name it", () => {
    const catalog = new Set(McpToolFactory.getAllTools().map((t) => t.name));
    expect(catalog.has("web_fetch")).toBe(true);
    // The family's defining modules exist and carry the tool: the
    // command names it, the service implements the fetch behind it.
    expect(read("src/mcps/openaimp/webFetchCommands.ts")).toContain('"web_fetch"');
    expect(existsSync(resolve(root, "src/services/webFetch.ts"))).toBe(true);
    expect(read("src/services/webFetch.ts")).toContain("stripHtmlToText");
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

  it("ai-search-service: the REST service exists, and its failure contract is the honest degraded one the family notes record (#1169 S3 acceptance)", () => {
    // Replaced by #1169 S3 (user directive 2026-11-04): this pin
    // asserted the in-repo fallback EXISTS (FINANCIAL_KNOWLEDGE_BASE
    // + provider "semantic_cache") because the family notes recorded
    // it. S3 removes the fallback; the acceptance pin now asserts
    // the opposite at greater strength — the constant and the
    // provider value are ABSENT from the service, the degraded
    // contract is present, and the notes record the degraded
    // contract (and no longer describe a live semantic_cache path).
    const service = read("src/services/aiSearch.ts");
    expect(service).toContain("AiSearchInstanceService");
    expect(service).not.toContain("FINANCIAL_KNOWLEDGE_BASE");
    expect(service).not.toContain("semantic_cache");
    expect(service).toContain("AiSearchDegradedReason");
    expect(service).toContain("endpoint_not_configured");
    const notes = getToolFamily("ai-search-service")!.notes ?? "";
    expect(notes).toContain("degraded");
    expect(notes).toContain("endpoint_not_configured");
    expect(notes).toContain("REMOVED by #1169 S3");
    // Adapted by #3342: the REST path is retired — the endpoint var
    // the primary path used to run against is DELETED from wrangler
    // vars, and the instance name the surviving namespace path runs
    // against is what stays configured.
    expect(
      (wrangler["vars"] as Record<string, unknown>)["AI_SEARCH_ENDPOINT"],
    ).toBeUndefined();
    expect(
      (wrangler["vars"] as Record<string, unknown>)["AI_SEARCH_INSTANCE"],
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
