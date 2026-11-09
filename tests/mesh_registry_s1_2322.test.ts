/**
 * Issue #2322 (Agent Mesh S1, programme #2225 G0) — the fleet
 * registry's drift pins.
 *
 * The registry (src/agents/registry.ts) is a checked projection of
 * code/config facts, never a second source of truth: every fact it
 * records is pinned here against the source that owns it —
 * wrangler.jsonc (DO + workflow bindings), src/a2a/ (cards +
 * resolutions, imported live), the McpToolFactory runtime catalog
 * plus the per-module command-name literals, and the agent/workflow
 * class declarations in source. If any of those move, this suite
 * fails and the registry must be updated in the same PR (gitops §7
 * pin rule).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MESH_AGENTS,
  MESH_SURFACES,
  MESH_CHANNELS,
  MESH_TOOL_FAMILIES,
  MESH_DOORS,
  MESH_WORKFLOWS,
  MESH_NON_RENAMES,
  getAgentByBinding,
  getAgentByClass,
  surfacesForClass,
  mcpCommandOwners,
} from "../src/agents/registry";
import { AGENT_CARDS } from "../src/a2a/agent-cards";
import { A2A_RESOLUTIONS } from "../src/a2a/resolution";
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

const wrangler = JSON.parse(stripJsonc(read("wrangler.jsonc"))) as {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  workflows: Array<{ binding: string; class_name: string }>;
};

/** Export aliases declared in src/server.ts: alias -> real class. */
const SERVER_ALIASES = new Map<string, string>();
for (const m of read("src/server.ts").matchAll(
  /export\s*\{\s*(\w+)\s+as\s+(\w+)\s*\}/g,
)) {
  SERVER_ALIASES.set(m[2], m[1]);
}
const resolveClassName = (name: string) => SERVER_ALIASES.get(name) ?? name;

// ---------------------------------------------------------------------------
// Shape / completeness of the registry itself
// ---------------------------------------------------------------------------

describe("mesh registry shape (#2322)", () => {
  it("agent class names and bindings are unique; every agent has a role and a source file that exists", () => {
    const classes = MESH_AGENTS.map((a) => a.className);
    expect(new Set(classes).size).toBe(classes.length);
    const bindings = MESH_AGENTS.flatMap((a) => a.bindings);
    expect(new Set(bindings).size).toBe(bindings.length);
    for (const agent of MESH_AGENTS) {
      expect(agent.bindings.length, agent.className).toBeGreaterThan(0);
      expect(agent.role.length, agent.className).toBeGreaterThan(0);
      expect(existsSync(resolve(root, agent.sourceFile)), agent.sourceFile).toBe(true);
    }
  });

  it("records exactly the five doors and the six channels (S13, #2412: NLQ webhook added; identity/gate/parity/adapter completed)", () => {
    expect(MESH_DOORS.map((d) => d.id).sort()).toEqual(
      ["a2a", "agent-as-a-tool", "chat-turn", "http-routes", "mcp"].sort(),
    );
    expect(MESH_CHANNELS.map((c) => c.id).sort()).toEqual(
      ["email", "nlq-webhook", "slack", "voice", "web-chat", "webhook"].sort(),
    );
    for (const channel of MESH_CHANNELS) {
      expect(channel.terminatesAt.length, channel.id).toBeGreaterThan(0);
      expect(channel.ingress.length, channel.id).toBeGreaterThan(0);
      expect(channel.identity.length, channel.id).toBeGreaterThan(0);
      expect(channel.gate.length, channel.id).toBeGreaterThan(0);
      expect(channel.parity.length, channel.id).toBeGreaterThan(0);
      expect(channel.adapter.length, channel.id).toBeGreaterThan(0);
    }
  });

  it("records 21 tool families (survey §8 fifteen + web_search, web_fetch, AI Search platform + the G1 mesh-door family, #2341 + the Agent Skills family, #2417 + the trading-limits family, #3888)", () => {
    expect(MESH_TOOL_FAMILIES).toHaveLength(21);
    const ids = MESH_TOOL_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("web-search");
    expect(ids).toContain("web-fetch");
    expect(ids).toContain("ai-search-platform");
    expect(ids).toContain("mesh-door-mcp-commands");
    expect(ids).toContain("agent-skills");
  });

  it("records the SearchAgent vs SearchHub/SearchAgentTab naming collision as a non-rename (survey §5)", () => {
    const entry = MESH_NON_RENAMES.find((n) =>
      n.names.includes("SearchHub"),
    );
    expect(entry).toBeDefined();
    expect(entry!.names).toEqual(
      expect.arrayContaining(["SearchAgent", "SearchHub", "SearchAgentTab"]),
    );
    // The UI names exist in the client and are a different thing from
    // the DO class: SearchHub/SearchAgentTab are /search UI surfaces.
    expect(existsSync(resolve(root, "src/client/search/SearchHub.tsx"))).toBe(true);
    expect(existsSync(resolve(root, "src/client/search/tabs/SearchAgentTab.tsx"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pin: wrangler.jsonc DO bindings <-> registry agents
// ---------------------------------------------------------------------------

describe("registry vs wrangler.jsonc DO bindings (#2322)", () => {
  it("every DO binding has exactly one registry entry and vice versa", () => {
    const wranglerBindings = wrangler.durable_objects.bindings.map((b) => b.name).sort();
    const registryBindings = MESH_AGENTS.flatMap((a) => a.bindings).sort();
    expect(registryBindings).toEqual(wranglerBindings);
  });

  it("each binding's wrangler class_name resolves (through server.ts export aliases) to the registry class", () => {
    for (const binding of wrangler.durable_objects.bindings) {
      const agent = getAgentByBinding(binding.name);
      expect(agent, binding.name).toBeDefined();
      expect(resolveClassName(binding.class_name), binding.name).toBe(agent!.className);
    }
  });

  it("AiSearchAgent is registered as it exists on main (#2223): AI_SEARCH_AGENT binding, PortThink class in src/agents/aiSearchAgent.ts", () => {
    const agent = getAgentByBinding("AI_SEARCH_AGENT");
    expect(agent).toBeDefined();
    expect(agent!.className).toBe("AiSearchAgent");
    expect(agent!.sourceFile).toBe("src/agents/aiSearchAgent.ts");
    expect(agent!.kind).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// Pin: agent/workflow class declarations in source <-> registry
// ---------------------------------------------------------------------------

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

describe("registry vs class declarations in source (#2322)", () => {
  it("every `export class X extends PortThink|DurableObject|McpAgent` in src/ is registered, and every registered class is declared with its recorded base", () => {
    const declared = new Map<string, string>();
    for (const file of walkTs(resolve(root, "src"))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(
        /export\s+class\s+(\w+)\s+extends\s+(PortThink|DurableObject|McpAgent)\b/g,
      )) {
        declared.set(m[1], m[2]);
      }
    }
    expect([...declared.keys()].sort()).toEqual(
      MESH_AGENTS.map((a) => a.className).sort(),
    );
    for (const agent of MESH_AGENTS) {
      expect(declared.get(agent.className), agent.className).toBe(agent.base);
    }
  });

  it("every ThinkWorkflow class in src/ is a registered workflow, with its wrangler binding", () => {
    const declared = new Set<string>();
    for (const file of walkTs(resolve(root, "src"))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/export\s+class\s+(\w+)\s+extends\s+ThinkWorkflow\b/g)) {
        declared.add(m[1]);
      }
    }
    expect([...declared].sort()).toEqual(
      MESH_WORKFLOWS.map((w) => w.className).sort(),
    );
    const wranglerWorkflows = new Map(
      wrangler.workflows.map((w) => [w.binding, w.class_name]),
    );
    for (const workflow of MESH_WORKFLOWS) {
      expect(wranglerWorkflows.get(workflow.binding), workflow.className).toBe(
        workflow.className,
      );
      expect(existsSync(resolve(root, workflow.sourceFile)), workflow.sourceFile).toBe(true);
      expect(workflow.starters.length, workflow.className).toBeGreaterThan(0);
    }
    expect(wranglerWorkflows.size).toBe(MESH_WORKFLOWS.length);
  });
});

// ---------------------------------------------------------------------------
// Pin: A2A cards + resolutions <-> registry surfaces (of owning classes)
// ---------------------------------------------------------------------------

describe("registry vs A2A cards and resolutions (#2322)", () => {
  it("registry surfaces are exactly the union of card names and resolution names", () => {
    const expected = new Set<string>([
      ...AGENT_CARDS.map((c) => c.name),
      ...Object.keys(A2A_RESOLUTIONS),
    ]);
    expect(new Set(MESH_SURFACES.map((s) => s.name))).toEqual(expected);
  });

  it("card/dispatch flags match the live catalog and resolution map", () => {
    const cardNames = new Set(AGENT_CARDS.map((c) => c.name));
    for (const surface of MESH_SURFACES) {
      expect(surface.card, surface.name).toBe(cardNames.has(surface.name));
      expect(surface.dispatch, surface.name).toBe(
        Object.prototype.hasOwnProperty.call(A2A_RESOLUTIONS, surface.name),
      );
    }
  });

  it("every surface's owning class is the class behind its resolution binding (surfaces, not agents — survey contradiction 9)", () => {
    for (const surface of MESH_SURFACES) {
      const resolution = A2A_RESOLUTIONS[surface.name as keyof typeof A2A_RESOLUTIONS];
      expect(resolution, surface.name).toBeDefined();
      const owner = getAgentByClass(surface.ownerClass);
      expect(owner, surface.name).toBeDefined();
      expect(owner!.bindings, surface.name).toContain(resolution.binding);
      expect(surfacesForClass(surface.ownerClass).map((s) => s.name)).toContain(surface.name);
    }
  });

  it("agents with no A2A surface record none (TickerAgent, SessionStore, OptionsScannerMCP)", () => {
    // SandboxAgent left this set in S15 (#2421): its A2A surface is
    // the #2253 recorded follow-up, landed with card + resolution +
    // dispatch — the census pins it in
    // tests/mesh_every_door_s15_2421.test.ts.
    for (const className of ["TickerAgent", "SessionStore", "OptionsScannerMCP"]) {
      expect(surfacesForClass(className), className).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Pin: MCP catalog <-> registry tool families
// ---------------------------------------------------------------------------

describe("registry vs MCP catalog (#2322)", () => {
  it("every McpToolFactory tool is accounted for by exactly one registry family, and vice versa", () => {
    const factoryNames = McpToolFactory.getAllTools().map((t) => t.name).sort();
    const owners = mcpCommandOwners();
    expect([...owners.keys()].sort()).toEqual(factoryNames);
    // Exactly one owner per command: family command lists never overlap.
    const listed = MESH_TOOL_FAMILIES.flatMap((f) => f.commands);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("each MCP family's command list matches the name literals in its source module(s)", () => {
    for (const family of MESH_TOOL_FAMILIES) {
      if (!family.commandSources) continue;
      const literals = new Set<string>();
      for (const source of family.commandSources) {
        const src = read(source.file);
        if (source.kind === "readonly-name") {
          for (const m of src.matchAll(/readonly\s+name\s*=\s*"([^"]+)"/g)) literals.add(m[1]);
        } else {
          for (const m of src.matchAll(/DeprecatedToolAlias\("([^"]+)"/g)) literals.add(m[1]);
        }
      }
      expect([...literals].sort(), family.id).toEqual([...family.commands].sort());
    }
  });

  it("the MAS tool family matches the createMAS tool set in src/agents/mas.ts", () => {
    const mas = MESH_TOOL_FAMILIES.find((f) => f.id === "mas-tools");
    expect(mas).toBeDefined();
    const src = read("src/agents/mas.ts");
    // createMAS's own return is the block that starts with
    // searchKnowledge (inner tool execute() returns are object
    // literals with properties, not bare tool-name lists).
    const returnBlock = src.match(/return\s*\{\s*(searchKnowledge,[^}]*)\};/);
    expect(returnBlock, "createMAS return block").not.toBeNull();
    const toolNames = returnBlock![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect([...(mas!.toolNames ?? [])].sort()).toEqual(toolNames);
  });
});
