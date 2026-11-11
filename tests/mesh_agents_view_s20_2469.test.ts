/**
 * Issue #2469 (Agent Mesh S20, programme #2225 G9) — the Agents view.
 *
 * The view's contract: what the operator sees IS the G0 registry
 * (src/agents/registry.ts), served by GET /api/agents/registry and
 * rendered from that payload — never a second, hand-maintained list.
 *
 * Pins:
 *  - every registry class carries a recorded status + reason (S20
 *    registry extension), and the degraded set is exactly the two
 *    classes whose degradation is evidenced in repo facts
 *    (AiSearchAgent: its namespace path is configured since #1169
 *    but not yet verified end-to-end — the seed+probe step is
 *    outstanding; SandboxAgent: no container backend is
 *    configured, so runs return executed:false);
 *  - the payload builder derives every section from the registry
 *    module — class set, per-class door census, census totals, tool
 *    family statuses, door budgets, trace breaks — so the served
 *    data cannot drift from the source of truth;
 *  - credential posture carries env NAMES only (A2A_TOKEN_*), never
 *    values;
 *  - the route handler refuses anonymous callers (401), refuses
 *    non-GET methods (405), and serves the payload to a session
 *    (200) — the /api/jobs/history decision shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MESH_AGENTS,
  MESH_CAPABILITY_DOORS,
  MESH_CHANNELS,
  MESH_DOORS,
  MESH_DOOR_COST_BUDGETS,
  MESH_G12_PROOF,
  MESH_IDENTITIES,
  MESH_SKILLS_ASSESSMENT,
  MESH_SURFACES,
  MESH_TOOL_FAMILIES,
  MESH_TRACE_SPINE,
  MESH_WORKFLOWS,
  capabilityDoorsForClass,
  getIdentityRecord,
} from "../src/agents/registry";
import { buildMeshRegistryView } from "../src/services/meshRegistryView";
import { handleMeshRegistryRoute } from "../src/agents/meshRegistryRoute";

const repoRoot = join(__dirname, "..");

describe("registry per-agent status records (S20 extension)", () => {
  it("every class carries a recorded status and a non-empty reason", () => {
    for (const agent of MESH_AGENTS) {
      expect(["live", "degraded"], agent.className).toContain(agent.status);
      expect(agent.statusReason.length, agent.className).toBeGreaterThan(0);
    }
  });

  it("the degraded set is exactly the two evidenced classes", () => {
    const degraded = MESH_AGENTS.filter((a) => a.status === "degraded").map(
      (a) => a.className,
    );
    expect(degraded.sort()).toEqual(["AiSearchAgent", "SandboxAgent"]);
  });

  it("the degraded records cite the repo facts that evidence them", () => {
    // Strip // comments first: wrangler.jsonc DISCUSSES both facts in
    // comments (the #1169 note records the binding's declaration;
    // the #2253 note names the missing Containers configuration).
    // The evidence is the DECLARATION state, not of the word.
    const wrangler = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8")
      .split("\n")
      .map((line) => line.split("//")[0])
      .join("\n");
    // AiSearchAgent: the namespace binding IS declared (namespace
    // "default", #1169); the record stays degraded on the
    // not-yet-probe-verified path, and its reason cites the config.
    expect(wrangler).toContain("ai_search_namespaces");
    const aiSearch = MESH_AGENTS.find((a) => a.className === "AiSearchAgent")!;
    expect(aiSearch.statusReason).toContain("wrangler.jsonc");
    // SandboxAgent: no container is declared any more (#4112 owner direction);
    // the class stays bound and its record keeps the honest degraded reason.
    expect(wrangler).not.toMatch(/^\s*"containers":/m);
    expect(wrangler).toContain('"SANDBOX_AGENT"');
    const sandbox = MESH_AGENTS.find((a) => a.className === "SandboxAgent")!;
    expect(sandbox.statusReason).toContain("executed:false");
  });
});

describe("buildMeshRegistryView — payload shape", () => {
  const view = buildMeshRegistryView();

  it("carries every registry section at the registry's own counts", () => {
    expect(view.counts).toEqual({
      agents: MESH_AGENTS.length,
      surfaces: MESH_SURFACES.length,
      doors: MESH_DOORS.length,
      workflows: MESH_WORKFLOWS.length,
      channels: MESH_CHANNELS.length,
      toolFamilies: MESH_TOOL_FAMILIES.length,
      censusCells: MESH_CAPABILITY_DOORS.length,
      censusExposed: MESH_CAPABILITY_DOORS.filter(
        (c) => c.status === "exposed",
      ).length,
    });
    expect(view.agents).toHaveLength(MESH_AGENTS.length);
    expect(view.surfaces).toHaveLength(MESH_SURFACES.length);
    expect(view.workflows).toHaveLength(MESH_WORKFLOWS.length);
    expect(view.channels).toHaveLength(MESH_CHANNELS.length);
    expect(view.toolFamilies).toHaveLength(MESH_TOOL_FAMILIES.length);
    expect(view.doors).toHaveLength(MESH_DOORS.length);
  });

  it("names the registry module as its source", () => {
    expect(view.source).toBe("src/agents/registry.ts");
  });

  it("carries the programme records: G12 proof, skills assessment, trace spine", () => {
    expect(view.programme.g12Proof.status).toBe(MESH_G12_PROOF.status);
    expect(view.programme.g12Proof.status).toBe("proven");
    expect(view.programme.skillsAssessment.recommendation).toBe(
      MESH_SKILLS_ASSESSMENT.recommendation,
    );
    expect(view.programme.traceSpine).toHaveLength(MESH_TRACE_SPINE.length);
  });
});

describe("buildMeshRegistryView — drift pin (the served data IS the registry)", () => {
  const view = buildMeshRegistryView();

  it("serves exactly the registry's class set, in registry order", () => {
    expect(view.agents.map((a) => a.className)).toEqual(
      MESH_AGENTS.map((a) => a.className),
    );
    for (const agentView of view.agents) {
      const entry = MESH_AGENTS.find((a) => a.className === agentView.className)!;
      expect(agentView.bindings).toEqual(entry.bindings);
      expect(agentView.status).toBe(entry.status);
      expect(agentView.statusReason).toBe(entry.statusReason);
      expect(agentView.role).toBe(entry.role);
    }
  });

  it("joins each class's census cells from the registry, verbatim", () => {
    for (const agentView of view.agents) {
      expect(agentView.doors).toEqual(
        capabilityDoorsForClass(agentView.className),
      );
    }
    const totalCells = view.agents.reduce((n, a) => n + a.doors.length, 0);
    expect(totalCells).toBe(MESH_CAPABILITY_DOORS.length);
    const exposedCells = view.agents.reduce(
      (n, a) => n + a.doors.filter((d) => d.status === "exposed").length,
      0,
    );
    expect(exposedCells).toBe(
      MESH_CAPABILITY_DOORS.filter((c) => c.status === "exposed").length,
    );
  });

  it("joins each class's identity record — the join is total", () => {
    for (const agentView of view.agents) {
      const record = getIdentityRecord(agentView.className);
      expect(record, agentView.className).toBeDefined();
      expect(agentView.identity).not.toBeNull();
      expect(agentView.identity!.did).toBe(record!.did);
      expect(agentView.identity!.meshCredentials).toEqual(
        record!.meshCredentials,
      );
      expect(agentView.identity!.credentialPosture).toBe(
        record!.credentialPosture,
      );
      expect(agentView.identity!.a2aSurfaces).toEqual(record!.a2aSurfaces);
    }
    expect(MESH_IDENTITIES).toHaveLength(MESH_AGENTS.length);
  });

  it("serves the tool families with their recorded statuses", () => {
    expect(
      view.toolFamilies.map((f) => ({ id: f.id, status: f.status })),
    ).toEqual(MESH_TOOL_FAMILIES.map((f) => ({ id: f.id, status: f.status })));
  });

  it("serves each door with its S19 cost-budget record", () => {
    for (const doorView of view.doors) {
      const budget = MESH_DOOR_COST_BUDGETS.find((b) => b.door === doorView.id);
      expect(budget, doorView.id).toBeDefined();
      expect(doorView.budget).toEqual(budget);
    }
  });

  it("serves the trace spine's recorded breaks, unedited", () => {
    const breaks = MESH_TRACE_SPINE.filter((e) => e.status === "break");
    expect(breaks.length).toBeGreaterThan(0);
    expect(view.programme.traceBreaks).toEqual(breaks);
  });

  it("credential posture carries env names only — every name an A2A_TOKEN_* var", () => {
    const union = new Set<string>();
    for (const record of MESH_IDENTITIES) {
      for (const name of record.meshCredentials) union.add(name);
    }
    expect(view.programme.credentialEnvNames).toEqual([...union].sort());
    for (const name of view.programme.credentialEnvNames) {
      expect(name).toMatch(/^A2A_TOKEN_[A-Z_]+$/);
    }
    for (const agentView of view.agents) {
      for (const name of agentView.identity!.meshCredentials) {
        expect(name).toMatch(/^A2A_TOKEN_[A-Z_]+$/);
      }
    }
  });
});

describe("handleMeshRegistryRoute — session-gated read route", () => {
  it("refuses anonymous callers with 401 and no payload", async () => {
    const res = await handleMeshRegistryRoute({ session: null, method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
    expect(body.agents).toBeUndefined();
  });

  it("refuses non-GET methods with 405", async () => {
    const res = await handleMeshRegistryRoute({
      session: { userLogin: "operator" },
      method: "POST",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("method_not_allowed");
  });

  it("serves the registry payload to a session", async () => {
    const res = await handleMeshRegistryRoute({
      session: { userLogin: "operator" },
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as ReturnType<typeof buildMeshRegistryView>;
    expect(body.agents.map((a) => a.className)).toEqual(
      MESH_AGENTS.map((a) => a.className),
    );
    expect(body.programme.g12Proof.status).toBe("proven");
  });
});
