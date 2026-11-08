/**
 * Issue #1738 — Agents SDK actor conformance regression tests
 * (successor to the #542 Think conformance suite, same idiom).
 *
 * Why source-evidence tests: the agents SDK module graph pulls
 * `cloudflare:` imports the node loader cannot resolve, so the suite
 * cannot instantiate a real Agent under Node. What it *can* pin —
 * and what silently regressed before the #542 file existed — is the
 * adoption evidence itself: the framework is pinned, every agent is
 * an Agents SDK actor (no Think agent class remains) — except
 * ResearchAgent since #1953 (think-fleet, shape (a): Think behind
 * the port via PortThink, pinned by the ResearchAgent test below),
 * each class is exported as a Durable Object, the bindings +
 * SQLite migrations exist, and the orchestrator actually
 * dispatches to the actor.
 * Removing any anchor fails this suite. (Repo precedent for this
 * style: tests/research-boundary.test.ts.)
 *
 * Scope note: these tests prove the actor path is wired, not that a
 * live actor turn behaves correctly in the Workers runtime — the
 * turn lifecycle itself is pinned by tests/actor-ports-conformance
 * (port + both adapters) and tests/orchestrator-actor-cutover.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// String-aware JSONC comment stripper (the #1387 idiom, also used
// by the A2A foundation suite): wrangler.jsonc carries // comments
// that may contain quotes, so a naive regex strip corrupts strings.
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

function parseWrangler(): {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  browser?: { binding?: string };
} {
  return JSON.parse(stripJsonc(read("wrangler.jsonc")));
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Agent conformance (issue #1738)", () => {
  it("the agents framework package is pinned to an exact version", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["agents"]).toMatch(EXACT_VERSION);
  });

  it("ResearchAgent extends PortThink with the framework overrides (issue #1953, think-fleet)", () => {
    const src = read("src/agents/research-agent.ts");
    // Think behind the actor port (tracker #1951, shape (a)): the
    // class reaches Think only through PortThink, never raw Think
    // and never the Agents SDK base it used before #1953.
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+ResearchAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    // The three overrides the SDK calls into (same surface Think
    // 0.19 exposed; verified against the installed agents package).
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
    // The agent's single tool is the read-only research pipeline.
    expect(src).toContain("run_options_research");
    // PortThink translates Think's hook calls into this object.
    expect(src).toContain("portHooks");
  });

  it("Agent adopters in src are exactly the designated roles (new adopters update this pin deliberately)", () => {
    const adopters = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => /extends\s+Agent</.test(read(path.relative(ROOT, f))))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    // No plain-Agent adopter remains: ReportAsset left this list
    // in #1958 (think-fleet), completing the migration — it now
    // extends PortThink, not Agent (its own pin lives in
    // tests/report-asset-agent.test.ts). Orchestrator left in
    // #1952, Research in #1953, Screener in #1955, Trading in
    // #1954, Scheduled in #1956, and Payments in #1957: all
    // seven extend PortThink now, which extends Think, which
    // extends Agent — so they are still Agents SDK actors, but
    // no longer match the plain-Agent pin.
    // BrowserAgent/SlackAgent likewise extend PortThink now
    // (Browser #1959, Slack #1960, tracker #1951) — they never
    // matched this pin (AIChatAgent before, PortThink now), so
    // the empty list is unchanged by their migration.
    expect(adopters).toEqual([]);
  });

  it("ScheduledAgent extends PortThink (issue #1956, think-fleet)", () => {
    const src = read("src/agents/scheduled-agent.ts");
    // Think behind the actor port (tracker #1951, shape (a)): the
    // class reaches Think only through PortThink, never raw Think
    // and never the Agents SDK base it used before #1956. This
    // class has no turn path, so unlike Research/Trading it
    // exposes no getModel/getSystemPrompt/getTools surface and
    // no portHooks — its cron/goal surface is pinned by
    // tests/think_fleet_scheduled_agent_1956.test.ts.
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+ScheduledAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/from\s*"agents"/);
  });

  it("no agent code imports the Think base directly, except the foundation adapter files (workflows subpath excepted)", () => {
    // Deliberate exception, not drift: the owner decision of
    // 2026-10-27 supersedes #1738's "no Think agent class remains"
    // criterion for shape (a) — Think behind the existing actor
    // port. Agent classes still must not import Think directly;
    // they reach it only through PortThink. The two foundation
    // adapter files (tracker #1951, foundation issue #1962) are
    // the sole files allowed to import the Think base, mirroring
    // the adjacent adopter pin's "new adopters update this pin
    // deliberately" pattern. Any other bare import still fails.
    const bareThink = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => read(path.relative(ROOT, f)).includes('from "@cloudflare/think"'))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    expect(bareThink).toEqual([
      "src/actors/thinkAdapter.ts",
      "src/actors/thinkPortMapping.ts",
    ]);
    // The workflows subpath is a different specifier and stays:
    // the five workflow classes are ThinkWorkflow by ADR 0004 W13.
    // Saga (#2041 S1) is the fourth foundation adapter, same
    // pattern as the other three — its addition here is deliberate.
    // JobPipeline (#3534) is the fifth, same pattern — its addition
    // here is deliberate.
    const workflowFiles = listTsFiles(path.join(ROOT, "src")).filter((f) =>
      read(path.relative(ROOT, f)).includes('from "@cloudflare/think/workflows"')
    );
    expect(
      workflowFiles
        .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
        .sort(),
    ).toEqual([
      "src/agents/trading-trade-workflow.ts",
      "src/workflows/jobPipelineWorkflow.ts",
      "src/workflows/paymentWorkflow.ts",
      "src/workflows/sagaWorkflow.ts",
      "src/workflows/screenerWorkflow.ts",
    ]);
  });

  it("the Worker exports ResearchAgent as a Durable Object class", () => {
    // Slice 9 of #2902 moves the exports to src/server/exports.ts;
    // server.ts re-exports them. The live export surface is both files.
    const server = read("src/server.ts") + read("src/server/exports.ts");
    expect(server).toMatch(
      /export\s*\{\s*ResearchAgent\s*\}\s*from\s*"\.{1,2}\/agents\/research-agent"/
    );
  });

  it("TradingAgent extends PortThink with the framework overrides (issue #291, migrated #1738, PortThink #1954)", () => {
    const src = read("src/agents/trading-agent.ts");
    // Think-fleet shape (a): the agent reaches Think ONLY through
    // PortThink (foundation adapter); a bare @cloudflare/think
    // import here would fail the adjacent bare-Think pin.
    expect(src).toMatch(/import\s*\{\s*PortThink[^}]*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+TradingAgent\s+extends\s+PortThink/);
    expect(src).not.toMatch(/from\s*"agents"/);
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
  });

  it("the Worker exports TradingAgent as a Durable Object class (issue #291)", () => {
    // Slice 9 of #2902 moves the exports to src/server/exports.ts;
    // server.ts re-exports them. The live export surface is both files.
    const server = read("src/server.ts") + read("src/server/exports.ts");
    expect(server).toMatch(
      /export\s*\{\s*TradingAgent\s*\}\s*from\s*"\.{1,2}\/agents\/trading-agent"/
    );
  });

  it("wrangler binds TRADING_AGENT to TradingAgent with a SQLite migration (issue #291)", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"TRADING_AGENT",\s*"class_name":\s*"TradingAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"TradingAgent"/);
  });

  it("wrangler binds RESEARCH_AGENT to ResearchAgent with a SQLite migration", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"RESEARCH_AGENT",\s*"class_name":\s*"ResearchAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"ResearchAgent"/);
  });

  it("wrangler binds BROWSER_AGENT to BrowserAgent with a SQLite migration (issue #2215)", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"BROWSER_AGENT",\s*"class_name":\s*"BrowserAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"BrowserAgent"/);
  });

  it("wrangler binds SLACK_AGENT to SlackAgent with a SQLite migration (issue #2215)", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"SLACK_AGENT",\s*"class_name":\s*"SlackAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"SlackAgent"/);
  });

  it("AiSearchAgent extends PortThink with the framework overrides (issue #2223)", () => {
    const src = read("src/agents/aiSearchAgent.ts");
    // Think behind the actor port (tracker #1951, shape (a)): the
    // class reaches Think only through PortThink, never raw Think
    // and never the Agents SDK base.
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+AiSearchAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    // Unlike Browser/Slack (no turn path), the port hooks ARE set:
    // the namespace-binding search is the turn tool as well as the
    // direct door (user priority directive 2026-10-29).
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
    expect(src).toContain("portHooks");
    // The agent's single tool is the search itself.
    expect(src).toContain("search: tool({");
    // Reference docs carried in the class header (issue directive).
    expect(src).toContain("https://developers.cloudflare.com/ai-search/");
    expect(src).toContain("https://developers.cloudflare.com/agents/tools/ai-search/");
    expect(src).toContain("https://developers.cloudflare.com/ai-search/agent-sdks/agents-sdk/");
    expect(src).toContain("https://developers.cloudflare.com/ai-search/api/search/mcp/");
    // OUT of scope (S4-5 bridge, #1169): no provisioning, no upload
    // calls on the class. (The REST degraded gate itself lives in
    // the runner, src/agents/aiSearchPaths.ts, and is
    // behavior-pinned in tests/a2a_aisearch_dispatch_p2223.test.ts.)
    expect(src).not.toMatch(/\.create\s*\(/);
    expect(src).not.toMatch(/items\.upload/);
  });

  it("the Worker exports AiSearchAgent as a Durable Object class (issue #2223)", () => {
    // Slice 9 of #2902 moves the exports to src/server/exports.ts;
    // server.ts re-exports them. The live export surface is both files.
    const server = read("src/server.ts") + read("src/server/exports.ts");
    expect(server).toMatch(
      /export\s*\{\s*AiSearchAgent\s*\}\s*from\s*"\.{1,2}\/agents\/aiSearchAgent"/
    );
  });

  it("wrangler binds AI_SEARCH_AGENT to AiSearchAgent with migration v12 (issue #2223)", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"AI_SEARCH_AGENT",\s*"class_name":\s*"AiSearchAgent"/
    );
    expect(wrangler).toMatch(
      /"tag":\s*"v12",\s*"new_sqlite_classes":\s*\[[^\]]*"AiSearchAgent"/
    );
    // The ai_search_namespaces binding IS declared as config since
    // the #1169 owner enablement landed (2026-11-05): the owner
    // provided the dashboard values (namespace "default", instance
    // screener-search), so the namespace code path (env.AI_SEARCH +
    // AI_SEARCH_INSTANCE) is configured as the live primary. The
    // check parses the config (comments stripped, as the slice-1
    // foundation suite does) so the explanatory comments in
    // wrangler.jsonc / src/types.ts don't trip it.
    const configOnly = wrangler.replace(/\/\/[^\n]*/g, "");
    expect(configOnly).toContain('"ai_search_namespaces"');
    // The entry's shape is the one WRANGLER's schema enforces
    // (issue #3321): ai_search_namespaces entries take a "binding"
    // field, NOT the "name" field the Durable Object entries use.
    // The enablement PR (#3319) shipped "name" and the pin asserted
    // it; the unit suite passed and the production deploy rejected
    // the config (wrangler deploy --dry-run is the authority:
    // 'bindings should have a string "binding" field'). This pin
    // now asserts the schema shape, including the negative: no
    // "name" key on the entry.
    expect(configOnly).toMatch(
      /"binding":\s*"AI_SEARCH",\s*"namespace":\s*"default",\s*"remote":\s*true/
    );
    expect(configOnly).not.toMatch(
      /"ai_search_namespaces":\s*\[\s*\{\s*"name"/
    );
  });

  it("SandboxAgent extends PortThink with deliberately unset port hooks (issue #2253)", () => {
    const src = read("src/agents/sandbox-agent.ts");
    // Think behind the actor port (tracker #1951, shape (a)): the
    // class reaches Think only through PortThink, never raw Think
    // and never the Agents SDK base.
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+SandboxAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/from\s*"agents"/);
    // No turn path: like Browser/Slack/Scheduled, the class sets no
    // port hooks and defines no model/prompt/tool surface — its
    // doors are domain methods (status + a run door), not a chat
    // turn. Giving it a model would be new behavior, not wiring.
    expect(src).not.toMatch(/this\.portHooks\s*=/);
    expect(src).not.toMatch(/getModel\(\)|getSystemPrompt\(\)|getTools\(\)/);
    // The agent delegates to the one service, constructed with the
    // bound container (this.ctx.container) or undefined fallback.
    expect(src).toContain("ETradeSandboxService");
    expect(src).toContain("new ETradeSandboxService(container, this.env)");
    // The header states the degraded posture in plain terms, so no
    // reader mistakes registration for a working sandbox.
    expect(src).toContain("no container backend is bound");
  });

  it("the Worker exports SandboxAgent as a Durable Object class (issue #2253)", () => {
    // Slice 9 of #2902 moves the exports to src/server/exports.ts;
    // server.ts re-exports them. The live export surface is both files.
    const server = read("src/server.ts") + read("src/server/exports.ts");
    expect(server).toMatch(
      /export\s*\{\s*SandboxAgent\s*\}\s*from\s*"\.{1,2}\/agents\/sandbox-agent"/
    );
  });

  it("wrangler binds SANDBOX_AGENT to SandboxAgent with migration v13 (issue #2253)", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"SANDBOX_AGENT",\s*"class_name":\s*"SandboxAgent"/
    );
    expect(wrangler).toMatch(
      /"tag":\s*"v13",\s*"new_sqlite_classes":\s*\[[^\]]*"SandboxAgent"/
    );
  });

  it("types.ts declares the SANDBOX_AGENT Env entry (issue #2253)", () => {
    const types = read("src/types.ts");
    expect(types).toMatch(/SANDBOX_AGENT\?:\s*DurableObjectNamespace;/);
  });

  it("wrangler declares the BROWSER Browser Rendering binding the code reads (issue #2253)", () => {
    // src/services/browserAgent.ts reads env.BROWSER (types.ts
    // declares BROWSER?: Fetcher); until this slice wrangler
    // declared no browser binding, so the deployed config could
    // never serve the real capture path and captures fell back to
    // the labelled placeholder (mesh survey G11 finding).
    const config = parseWrangler();
    expect(config.browser?.binding).toBe("BROWSER");
  });

  it("fleet completeness: every agent class in src is bound, and every bound DO class resolves (issue #2253)", () => {
    const config = parseWrangler();
    const boundClasses = new Set(
      config.durable_objects.bindings.map((b) => b.class_name)
    );
    // Source-derived enumeration — NOT a hardcoded list, so the
    // NEXT agent is caught too: every exported class under src/
    // whose base is PortThink (the fleet's agent base), McpAgent
    // (the MCP server), or DurableObject (SessionStore's plain
    // DO base).
    const agentClasses = new Set<string>();
    for (const file of listTsFiles(path.join(ROOT, "src"))) {
      const text = read(path.relative(ROOT, file));
      for (const m of text.matchAll(
        /export\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+(?:PortThink|McpAgent|DurableObject)\b/g
      )) {
        agentClasses.add(m[1]);
      }
    }
    // Tripwire: a silently-empty enumeration must fail here rather
    // than vacuously pass both directions below.
    expect(agentClasses.size).toBeGreaterThanOrEqual(12);
    // class → binding: an unbound agent class is named in the failure.
    // The transitional alias exception that lived here is retired:
    // during the two-deploy G0 rename's A→B window (#2330, gate record
    // #2326), OrchestratorAgent was bound only under its export alias
    // (ORCHESTRATOR_AGENT → class_name "SearchAgent"); Deploy B (#2523)
    // renamed the alias namespace onto the class name (migration v15),
    // so every agent class is now bound under its own name and the
    // exception is empty. The exact-membership assertion keeps the
    // exception itself pinned rather than open-ended.
    const TRANSITIONAL_ALIAS_ONLY: string[] = [];
    expect(boundClasses.has("OrchestratorAgent")).toBe(true);
    const unbound = [...agentClasses]
      .filter(
        (c) => !boundClasses.has(c) && !TRANSITIONAL_ALIAS_ONLY.includes(c)
      )
      .sort();
    expect(
      unbound,
      `agent classes with no wrangler DO binding: ${unbound.join(", ")}`
    ).toEqual([]);
    // binding → class: every bound class_name must resolve to a
    // class defined in src/ OR a name the worker entrypoint exports
    // (OrchestratorAgent resolves here under its own name since the
    // #2523 rename retired the SearchAgent alias).
    const exportedNames = new Set<string>();
    const server = read("src/server.ts");
    for (const m of server.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const entry of m[1].split(",")) {
        const parts = entry.trim().split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0]).trim();
        if (name) exportedNames.add(name);
      }
    }
    const unresolvable = [...boundClasses]
      .filter((c) => !agentClasses.has(c) && !exportedNames.has(c))
      .sort();
    expect(
      unresolvable,
      `wrangler DO classes resolving to nothing in src/: ${unresolvable.join(", ")}`
    ).toEqual([]);
  });

  it("the orchestrator dispatches research through the Agent actor", () => {
    const orchestrator = read("src/agents/orchestrator.ts");
    // The dispatch call itself lives in the extracted researchPublish
    // module (#992 subset 2); the class wires that module in.
    const researchPublish = read("src/agents/orchestrator/researchPublish.ts");
    // Per-tenant instance resolution off the DO binding…
    expect(orchestrator).toContain("this.env.RESEARCH_AGENT");
    expect(orchestrator).toContain("research:${login}");
    // …and the agent-tool dispatch that runs the SDK actor run.
    expect(researchPublish).toContain("runAgentTool(ResearchAgent");
  });

  it("the test harness is the in-memory actor adapter plus a test-only Think stub", () => {
    const vite = read("vite.config.ts");
    // Issue #2003 (tracker #1951) restates this pin: the bare
    // @cloudflare/think alias is back, but TEST-ONLY — it points at
    // tests/stubs/cloudflareThink.ts, a stub that imports nothing
    // and whose turn methods throw, so the real Think graph (with
    // its `cloudflare:` imports) never loads under Node vitest. The
    // workflows alias stays (workflow files still import that
    // subpath), and no production file may import the stub.
    expect(vite).toContain('"@cloudflare/think":');
    expect(vite).toContain("tests/stubs/cloudflareThink.ts");
    expect(fs.existsSync(path.join(ROOT, "tests/stubs/cloudflareThink.ts"))).toBe(true);
    expect(vite).toContain('"@cloudflare/think/workflows"');
    const stub = read("tests/stubs/cloudflareThink.ts");
    // The stub must import nothing workerd-only (its header may
    // NAME the schemes it avoids, so check imports, not mentions).
    expect(stub).not.toMatch(/from\s+"cloudflare:/);
    expect(stub).not.toMatch(/from\s+"@cloudflare\/think"/);
    expect(stub).toContain("runTurn() is not implemented under Node tests");
    // The turn harness itself is unchanged: the in-memory actor
    // adapter runs the same turn runner with a stubbed provider
    // boundary (see tests/actor-ports-conformance.test.ts).
    const adapter = read("src/actors/inMemoryActorAdapter.ts");
    expect(adapter).toContain("createInMemoryActorTurn");
    expect(adapter).toContain("Stub assistant reply.");
  });
});
