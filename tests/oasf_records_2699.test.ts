/**
 * Issue #2699 (programme #2494, AGNTCY slice 1) — OASF record
 * generation drift pins.
 *
 * The generator (src/services/oasfRecords.ts) derives OASF v1.1.0
 * records from the two existing sources of truth — the mesh
 * registry + A2A agent cards, and the McpToolFactory catalog — and
 * from nothing else. These pins fail when a source moves without
 * the generator's pinned mapping tables following: a new card, a
 * new capability, a new catalog tool, or a new owning family must
 * either map through the tables or fail CI here (gitops §7 pin
 * rule, same pattern as S1/S14).
 *
 * Generation is local only: no route serves these records and
 * nothing is published. The last pin enforces that boundary in
 * source: no other src module may import the generator.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_CARDS } from "../src/a2a/agent-cards";
import {
  MESH_SURFACES,
  MESH_TOOL_FAMILIES,
  mcpCommandOwners,
} from "../src/agents/registry";
import { MCP_TOOLS, MCP_SERVER_INFO } from "../src/mcps/openaimp/index";
import {
  OASF_SCHEMA_VERSION,
  CAPABILITY_OASF_SKILLS,
  MCP_FAMILY_OASF_SKILLS,
  CARD_OASF_DOMAINS,
  oasfSkillsForCapability,
  oasfSkillsForMcpTool,
  buildAgentOasfRecord,
  buildMcpServerOasfRecord,
  generateOasfRecords,
  validateOasfRecord,
  type OasfRecord,
} from "../src/services/oasfRecords";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CREATED_AT = "2026-11-01T00:00:00Z";

const generated = generateOasfRecords({ createdAt: CREATED_AT });

describe("record set == source sets", () => {
  it("one agent record per A2A card, named by the card", () => {
    expect(generated.agents).toHaveLength(AGENT_CARDS.length);
    expect(generated.agents.map((r) => r.name)).toEqual(
      AGENT_CARDS.map((c) => c.name),
    );
  });

  it("every card-carrying registry surface has a record; dispatch-only surfaces do not", () => {
    const names = new Set(generated.agents.map((r) => r.name));
    for (const surface of MESH_SURFACES) {
      if (surface.card) {
        expect(names.has(surface.name), `surface ${surface.name}`).toBe(true);
      } else {
        expect(names.has(surface.name), `surface ${surface.name}`).toBe(false);
      }
    }
  });

  it("exactly one MCP server record, named and versioned from MCP_SERVER_INFO", () => {
    expect(generated.server.name).toBe(MCP_SERVER_INFO.name);
    expect(generated.server.version).toBe(MCP_SERVER_INFO.version);
    expect(generated.server.description).toBe(MCP_SERVER_INFO.description);
  });

  it("the server record's MCP module carries exactly the catalog tools, sorted", () => {
    const mod = generated.server.modules?.find((m) => m.name === "integration/mcp");
    expect(mod).toBeDefined();
    const tools = (mod!.data.tools as Array<{ name: string }>).map((t) => t.name);
    expect(tools).toEqual(MCP_TOOLS.map((t) => t.name).sort());
  });
});

describe("mapping tables are complete and carry no stale entries", () => {
  it("every card capability maps through the table", () => {
    for (const card of AGENT_CARDS) {
      for (const capability of card.capabilities) {
        expect(
          CAPABILITY_OASF_SKILLS[capability],
          `${card.name}:${capability}`,
        ).toBeDefined();
        expect(oasfSkillsForCapability(capability).length).toBeGreaterThan(0);
      }
    }
  });

  it("every capability mapping key is a capability some card declares", () => {
    const declared = new Set(AGENT_CARDS.flatMap((c) => c.capabilities));
    for (const key of Object.keys(CAPABILITY_OASF_SKILLS)) {
      expect(declared.has(key), `stale capability mapping ${key}`).toBe(true);
    }
  });

  it("every catalog tool resolves to skills through its owning family", () => {
    const owners = mcpCommandOwners();
    for (const tool of MCP_TOOLS) {
      expect(owners.get(tool.name), `unowned tool ${tool.name}`).toBeDefined();
      expect(oasfSkillsForMcpTool(tool.name).length).toBeGreaterThan(0);
    }
  });

  it("every family mapping key is a registry family that owns catalog tools", () => {
    const owners = mcpCommandOwners();
    const owningFamilies = new Set(owners.values());
    for (const key of Object.keys(MCP_FAMILY_OASF_SKILLS)) {
      expect(
        MESH_TOOL_FAMILIES.some((f) => f.id === key),
        `unknown family ${key}`,
      ).toBe(true);
      expect(owningFamilies.has(key), `family ${key} owns no catalog tool`).toBe(
        true,
      );
    }
    // And the converse: every family that owns catalog tools is mapped.
    for (const familyId of owningFamilies) {
      expect(MCP_FAMILY_OASF_SKILLS[familyId], `unmapped family ${familyId}`).toBeDefined();
    }
  });

  it("every card has exactly one domain mapping, with no stale entries", () => {
    expect(Object.keys(CARD_OASF_DOMAINS).sort()).toEqual(
      AGENT_CARDS.map((c) => c.name).sort(),
    );
  });

  it("taxonomy refs are internally consistent: one id per name, one name per id", () => {
    const byName = new Map<string, number>();
    const byId = new Map<number, string>();
    const refs = [
      ...Object.values(CAPABILITY_OASF_SKILLS).flat(),
      ...Object.values(MCP_FAMILY_OASF_SKILLS).flat(),
      ...Object.values(CARD_OASF_DOMAINS),
    ];
    for (const ref of refs) {
      if (byName.has(ref.name)) expect(byName.get(ref.name)).toBe(ref.id);
      if (byId.has(ref.id)) expect(byId.get(ref.id)).toBe(ref.name);
      byName.set(ref.name, ref.id);
      byId.set(ref.id, ref.name);
    }
  });

  it("an unmapped capability fails loudly", () => {
    expect(() => oasfSkillsForCapability("no-such-capability")).toThrow(
      /unmapped/,
    );
    expect(() => oasfSkillsForMcpTool("no_such_tool")).toThrow(/unmapped|no owning family/);
    const realCard = AGENT_CARDS.find((c) => c.name === "sandbox")!;
    const bogusCard = { ...realCard, capabilities: ["no-such-capability"] };
    expect(() => buildAgentOasfRecord(bogusCard, { createdAt: CREATED_AT })).toThrow(
      /unmapped/,
    );
  });
});

describe("records validate against the OASF v1.1.0 record contract", () => {
  it("every generated record validates with zero errors", () => {
    for (const record of [...generated.agents, generated.server]) {
      expect(validateOasfRecord(record), record.name).toEqual([]);
    }
  });

  it("every record carries the pinned schema version and the supplied created_at", () => {
    for (const record of [...generated.agents, generated.server]) {
      expect(record.schema_version).toBe(OASF_SCHEMA_VERSION);
      expect(record.schema_version).toBe("1.1.0");
      expect(record.created_at).toBe(CREATED_AT);
    }
  });

  it("every skill on every record is drawn from the mapping tables", () => {
    const allowed = new Set(
      [
        ...Object.values(CAPABILITY_OASF_SKILLS).flat(),
        ...Object.values(MCP_FAMILY_OASF_SKILLS).flat(),
      ].map((s) => `${s.id}:${s.name}`),
    );
    for (const record of [...generated.agents, generated.server]) {
      for (const skill of record.skills) {
        expect(allowed.has(`${skill.id}:${skill.name}`), `${record.name}:${skill.name}`).toBe(true);
      }
    }
  });

  it("the validator rejects contract violations", () => {
    const good = generated.agents[0];
    const missing = { ...good } as Partial<OasfRecord>;
    delete missing.skills;
    expect(validateOasfRecord(missing as OasfRecord)).not.toEqual([]);

    const freeText = {
      ...good,
      skills: [{ id: 999999, name: "made/up/skill" }],
    };
    expect(validateOasfRecord(freeText)).not.toEqual([]);

    const badTimestamp = { ...good, created_at: "yesterday" };
    expect(validateOasfRecord(badTimestamp)).not.toEqual([]);

    const noAuthors = { ...good, authors: [] };
    expect(validateOasfRecord(noAuthors)).not.toEqual([]);
  });

  it("generation rejects a non-RFC3339 created_at", () => {
    expect(() => generateOasfRecords({ createdAt: "2026-11-01" })).toThrow(
      /RFC3339/,
    );
  });
});

describe("determinism and the sample record", () => {
  it("same sources and created_at produce byte-identical records", () => {
    const again = generateOasfRecords({ createdAt: CREATED_AT });
    expect(JSON.stringify(again)).toBe(JSON.stringify(generated));
    const serverAgain = buildMcpServerOasfRecord({ createdAt: CREATED_AT });
    expect(JSON.stringify(serverAgain)).toBe(JSON.stringify(generated.server));
  });

  it("the sandbox agent record matches the pinned sample exactly", () => {
    const sandbox = generated.agents.find((r) => r.name === "sandbox");
    expect(sandbox).toEqual({
      name: "sandbox",
      version: "1.0.0",
      schema_version: "1.1.0",
      description:
        "Reports the sandbox's backend status and runs shell commands through SandboxAgent's one service (ETradeSandboxService). Honestly degraded in this deployment: no container backend is bound, so run_command returns executed:false with exitCode:null and no fabricated output until an owner binds one — check sandbox.status first.",
      authors: ["OpenAIMP"],
      created_at: CREATED_AT,
      locators: [
        {
          type: "url",
          urls: [
            "https://agent.openaimp.com/a2a/sandbox/agent-card.json",
            "https://agent.openaimp.com/a2a/sandbox",
          ],
        },
      ],
      skills: [
        { id: 1703, name: "tool_use_automation/script_integration" },
        {
          id: 90801,
          name: "devops_cloud_infra/observability/monitoring_alerting",
        },
      ],
      domains: [{ id: 102, name: "technology/software_engineering" }],
      annotations: {
        "openaimp.surface": "sandbox",
        "openaimp.owner_class": "SandboxAgent",
      },
    });
  });

  it("records carry the owner class DID annotation exactly when the registry records one", () => {
    const trading = generated.agents.find((r) => r.name === "trading");
    expect(trading?.annotations?.["openaimp.did"]).toBe(
      "did:agent:openaimp:trading",
    );
    const sandbox = generated.agents.find((r) => r.name === "sandbox");
    expect(sandbox?.annotations?.["openaimp.did"]).toBeUndefined();
  });
});

describe("hard boundary: local generation only", () => {
  it("no other src module imports the generator (no route, no runtime path)", () => {
    const srcRoot = join(root, "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && entry.name !== "oasfRecords.ts") {
          const text = readFileSync(path, "utf8");
          if (/from\s+["'][^"']*oasfRecords["']/.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
