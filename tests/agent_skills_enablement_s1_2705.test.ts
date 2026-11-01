/**
 * Issue #2705 (Agents SDK Skills enablement, slice 1; owner
 * direction 2026-11-01 executing #2460's adopt-as-packaging
 * recommendation) — OrchestratorAgent serves ONE in-repo
 * code-manifest skill pack through Think's getSkills() hook.
 *
 * Pins:
 *  (a) delegation — the real OrchestratorAgent.getSkills() returns
 *      exactly one source, built by the extracted module
 *      (src/agents/orchestrator/skillPacks.ts, #992 pattern);
 *  (b) the pack — the canonical SKILL.md on disk parses clean
 *      under the SDK's own parser (zero warnings), its frontmatter
 *      equals the manifest entry the module serves, the embedded
 *      copy equals the file byte-for-byte, and the body carries
 *      the required sections and every door refusal code;
 *  (c) CONFORMANCE, driven at the SDK seam — the class's own
 *      getSkills() output feeds the SDK's real catalog loader
 *      (loadSkillCatalog: the loader Think's _loadSkillCatalog
 *      runs) and the SDK's real turn tool factory
 *      (createSkillTools: the factory Think spreads into the
 *      turn's tool set at assembly). With the source present the
 *      tool set is exactly activate_skill + read_skill_resource
 *      (no run_skill_script — no runner is configured), and both
 *      tools are EXECUTED here: activation returns the pack's
 *      instructions, the resource read returns the bundled
 *      examples. With no sources the catalog is empty and the
 *      factory returns an empty tool set.
 *
 * What this does NOT prove, stated plainly (the residue): a live
 * model turn runs under workerd. The repo's Node harness stubs
 * @cloudflare/think (#2003) and its runTurn refuses, so no suite
 * here can observe the model choosing to activate the pack in a
 * production turn. The shipped-runtime pins below hold the two
 * production facts the claim rests on: Think's _initializeSkills
 * early-returns on zero sources (no catalog, no skills tools),
 * and its turn assembly spreads createSkillTools(this._skillCatalog)
 * into the tool set. Everything between getSkills() and the model
 * invocation is driven above with the shipped SDK modules
 * (agents/skills — the module Think itself imports and re-exports
 * as its skills namespace).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

// The think_scheduled_tasks_observe_2693.test.ts idiom: mock the
// Agents SDK base so the real module graph loads under Node;
// "@cloudflare/think" resolves to the test-only stub via
// vite.config. NOTE: only the bare "agents" specifier is mocked —
// "agents/skills" (the skills modules Think itself runs) loads
// for real, which is what makes the conformance pins below driven
// rather than asserted.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

import { loadSkillCatalog, parseSkill } from "agents/skills";
import { createSkillTools } from "agents/skills/tools/ai-sdk";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import {
  CHAT_SCREENING_DOORS_SKILL_MD,
  CHAT_SCREENING_DOORS_EXAMPLES_MD,
  CHAT_SCREENING_DOORS_PACK,
  CHAT_SCREENING_PACK_NAME,
  CHAT_SCREENING_SKILLS_SOURCE_ID,
  buildOrchestratorSkillSources,
} from "../src/agents/orchestrator/skillPacks";
import {
  MESH_SKILLS_ASSESSMENT,
  MESH_TOOL_FAMILIES,
} from "../src/agents/registry";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const PACK_DIR = "src/agents/orchestrator/skills/chat-screening-doors";
const REFUSAL_CODES = [
  "identity_required",
  "door_unavailable",
  "invalid_strategy_type",
  "nd_mode_unavailable",
  "screen_intent_required",
  "budget_denied",
  "price_unavailable",
  "checkout_email_required",
];

describe("the chat-screening-doors pack (#2705)", () => {
  it("(b) the canonical SKILL.md on disk equals the module's embedded copy, byte-for-byte", () => {
    expect(read(`${PACK_DIR}/SKILL.md`)).toBe(CHAT_SCREENING_DOORS_SKILL_MD);
    expect(read(`${PACK_DIR}/examples.md`)).toBe(CHAT_SCREENING_DOORS_EXAMPLES_MD);
  });

  it("(b) parses clean under the SDK's own parser: zero warnings, frontmatter equals the served manifest entry", () => {
    const parsed = parseSkill(CHAT_SCREENING_DOORS_SKILL_MD, {
      directory: CHAT_SCREENING_PACK_NAME,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("pack must parse");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.value.name).toBe(CHAT_SCREENING_PACK_NAME);
    expect(CHAT_SCREENING_DOORS_PACK.name).toBe(parsed.value.name);
    expect(CHAT_SCREENING_DOORS_PACK.description).toBe(parsed.value.description);
    expect(CHAT_SCREENING_DOORS_PACK.body).toBe(parsed.value.body);
  });

  it("(b) the body carries the required sections, both doors, and every refusal code", () => {
    const { body } = CHAT_SCREENING_DOORS_PACK;
    for (const section of [
      "## Door selection",
      "## Identity carriage",
      "## Refusal codes",
      "## The never-deflect rule",
      "run_stock_screen",
      "run_options_strategy_screen",
      "no_opportunities",
      "identity_required",
    ]) {
      expect(body, section).toContain(section);
    }
    for (const code of REFUSAL_CODES) {
      expect(body, code).toContain(code);
    }
    expect(body).toContain("never a tool argument");
    expect(body).toContain("examples.md");
  });

  it("(b) the bundled examples resource is the on-disk examples file", () => {
    const resources = CHAT_SCREENING_DOORS_PACK.resources ?? [];
    expect(resources.map((r) => r.path)).toEqual(["examples.md"]);
    expect(resources[0].content).toBe(CHAT_SCREENING_DOORS_EXAMPLES_MD);
    expect(CHAT_SCREENING_DOORS_EXAMPLES_MD).toContain("Worked examples");
  });
});

describe("the code-manifest source (#2705)", () => {
  it("(a) the module builds exactly one source, listing exactly the one pack, no invalid entries", async () => {
    const sources = buildOrchestratorSkillSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(CHAT_SCREENING_SKILLS_SOURCE_ID);
    const listing = await sources[0].list();
    expect(listing.ok).toBe(true);
    if (!listing.ok) throw new Error("source must list");
    expect(listing.value.invalid).toEqual([]);
    expect(listing.value.skills.map((s) => s.skill.name)).toEqual([
      CHAT_SCREENING_PACK_NAME,
    ]);
  });

  it("(a) the source serves the bundled resource through the SkillSource contract", async () => {
    const [source] = buildOrchestratorSkillSources();
    const resource = await source.readResource(
      CHAT_SCREENING_PACK_NAME as never,
      "examples.md" as never,
    );
    expect(resource.ok).toBe(true);
    if (!resource.ok) throw new Error("resource must read");
    expect(JSON.stringify(resource.value)).toContain("Worked examples");
  });

  it("(a) OrchestratorAgent.getSkills() delegates: the real class returns the same one source", async () => {
    const agent = Object.create(OrchestratorAgent.prototype) as OrchestratorAgent;
    const sources = await agent.getSkills();
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(CHAT_SCREENING_SKILLS_SOURCE_ID);
    const listing = await sources[0].list();
    expect(listing.ok).toBe(true);
    if (!listing.ok) throw new Error("class source must list");
    expect(listing.value.skills.map((s) => s.skill.name)).toEqual([
      CHAT_SCREENING_PACK_NAME,
    ]);
  });
});

describe("conformance — the turn tool set at the SDK seam (#2705)", () => {
  it("(c) source present: the catalog loads the pack and the turn factory yields exactly the two skills tools", async () => {
    const agent = Object.create(OrchestratorAgent.prototype) as OrchestratorAgent;
    const catalog = await loadSkillCatalog(await agent.getSkills());
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.skills.map((s) => s.skill.name)).toEqual([
      CHAT_SCREENING_PACK_NAME,
    ]);
    const prompt = catalog.prompt();
    expect(prompt).toContain(CHAT_SCREENING_PACK_NAME);
    expect(prompt).toContain("activate_skill");

    const tools = createSkillTools(catalog, { scriptRunner: null });
    expect(Object.keys(tools).sort()).toEqual(
      ["activate_skill", "read_skill_resource"].sort(),
    );
    expect(tools).not.toHaveProperty("run_skill_script");
  });

  it("(c) driven activation: executing activate_skill returns the pack's instructions to the model", async () => {
    const catalog = await loadSkillCatalog(buildOrchestratorSkillSources());
    const tools = createSkillTools(catalog, { scriptRunner: null });
    const execute = tools["activate_skill"]?.execute;
    expect(typeof execute).toBe("function");
    const result = await execute!(
      { name: CHAT_SCREENING_PACK_NAME },
      { toolCallId: "skills-s1-activation", messages: [] } as never,
    );
    const text = typeof result === "string" ? result : JSON.stringify(result);
    expect(text).toContain(`<skill_content name="${CHAT_SCREENING_PACK_NAME}">`);
    expect(text).toContain("The never-deflect rule");
    expect(text).toContain("identity_required");
  });

  it("(c) driven resource read: executing read_skill_resource returns the bundled examples", async () => {
    const catalog = await loadSkillCatalog(buildOrchestratorSkillSources());
    const tools = createSkillTools(catalog, { scriptRunner: null });
    const execute = tools["read_skill_resource"]?.execute;
    expect(typeof execute).toBe("function");
    const result = await execute!(
      { name: CHAT_SCREENING_PACK_NAME, path: "examples.md" },
      { toolCallId: "skills-s1-resource", messages: [] } as never,
    );
    const text = typeof result === "string" ? result : JSON.stringify(result);
    expect(text).toContain("Worked examples");
    expect(text).toContain("bull put credit spreads");
  });

  it("(c) source absent: an empty source list yields an empty catalog and an empty tool set", async () => {
    const catalog = await loadSkillCatalog([]);
    expect(catalog.skills).toEqual([]);
    expect(catalog.prompt()).toBeNull();
    const tools = createSkillTools(catalog, { scriptRunner: null });
    expect(Object.keys(tools)).toEqual([]);
  });

  it("(c) the shipped Think runtime wires the seam this suite drives (production facts, pinned)", () => {
    // The Node harness stubs @cloudflare/think (#2003), so Think's
    // own turn assembly cannot execute here. These are the two
    // shipped-runtime facts the conformance claim rests on, read
    // from the installed package the production build bundles:
    // (1) zero sources -> _initializeSkills returns before any
    // catalog exists, and _skillCatalog stays null;
    // (2) turn assembly spreads createSkillTools(this._skillCatalog)
    // into the tool set — the same factory driven above.
    const distDir = resolve(root, "node_modules/@cloudflare/think/dist");
    const runtime = readdirSync(distDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(distDir, f), "utf8"))
      .join("\n");
    expect(runtime).toContain("if (sources.length === 0) return;");
    expect(runtime).toContain("createSkillTools(this._skillCatalog");
    expect(runtime).toContain("getSkills() {");
  });
});

describe("registry truth after slice 1 (#2705)", () => {
  it("the agent-skills family is live, adopted on OrchestratorAgent only", () => {
    const family = MESH_TOOL_FAMILIES.find((f) => f.id === "agent-skills");
    expect(family?.status).toBe("live");
    expect(family?.source).toContain("skillPacks.ts");
    expect([...(family?.toolNames ?? [])].sort()).toEqual(
      ["activate_skill", "read_skill_resource", "run_skill_script"].sort(),
    );
  });

  it("the skills assessment records the first-slice adoption under this issue", () => {
    expect(MESH_SKILLS_ASSESSMENT.recommendation).toBe("adopt-as-packaging");
    expect(MESH_SKILLS_ASSESSMENT.adoptionState).toContain("2705");
    expect(MESH_SKILLS_ASSESSMENT.adoptionState).toMatch(/first slice/i);
  });
});
