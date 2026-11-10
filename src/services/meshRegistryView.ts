/**
 * Issue #2469 (Agent Mesh S20, programme #2225 G9) — the Agents
 * view payload: a pure projection of the G0 registry
 * (src/agents/registry.ts) for the read route
 * (src/agents/meshRegistryRoute.ts) and the client panel
 * (src/client/AgentsPanel.tsx, type-only import).
 *
 * The registry is the single source of truth for the fleet. This
 * builder COMPOSES its exports at call time — each class joined
 * with its S15 census cells (capabilityDoorsForClass), its S16
 * identity record (getIdentityRecord), and its capability manifest
 * (capabilitiesForClass, Uniform Copilot Standard S1 #3489), each door joined with its
 * S19 cost-budget record — and copies nothing into a second
 * hand-maintained list. The platform capabilities
 * (platformCapabilities, #3700) ride as a top-level section,
 * derived from the manifest module. tests/mesh_agents_view_s20_2469.test.ts
 * drift-pins the payload against the registry module, so the
 * served data cannot silently diverge from the record.
 *
 * Credential posture is carried as env NAMES and the recorded
 * posture text only — never a secret value (no value exists in
 * the registry to copy).
 */
import {
  MESH_AGENTS,
  MESH_CHANNELS,
  MESH_DOORS,
  MESH_G12_PROOF,
  MESH_IDENTITIES,
  MESH_SKILLS_ASSESSMENT,
  MESH_SURFACES,
  MESH_TOOL_FAMILIES,
  MESH_TRACE_SPINE,
  MESH_WORKFLOWS,
  capabilitiesForClass,
  capabilityDoorsForClass,
  doorCostBudget,
  getIdentityRecord,
  platformCapabilities,
  type AgentCapabilityManifest,
  type MeshAgentEntry,
  type MeshCapabilityDoorEntry,
  type MeshChannelEntry,
  type MeshDoorCostBudgetEntry,
  type MeshDoorEntry,
  type MeshIdentityRecord,
  type MeshSurfaceEntry,
  type MeshToolFamilyEntry,
  type MeshTraceSpineEntry,
  type MeshWorkflowEntry,
  type PlatformCapability,
} from "../agents/registry";

/** One fleet class as the view serves it: the registry entry, its
 * census cells, and its identity record, joined by class name. */
export interface MeshAgentView extends MeshAgentEntry {
  doors: MeshCapabilityDoorEntry[];
  identity: MeshIdentityRecord | null;
  /**
   * The class's capability manifest (Uniform Copilot Standard S1,
   * #3489): channels × runtime capabilities × tools with truthful
   * states, resolved from externalized config at the code posture
   * (this payload is env-free by design — prerequisites are
   * recorded on the entries, not evaluated here). Non-null exactly
   * for PortThink entries; the manifest covers the Think fleet.
   */
  capabilities: AgentCapabilityManifest | null;
}

/** One door with its S19 cost-budget record attached. */
export interface MeshDoorView extends MeshDoorEntry {
  budget: MeshDoorCostBudgetEntry;
}

export interface MeshRegistryView {
  /** The module this payload is derived from — the source of truth. */
  source: "src/agents/registry.ts";
  counts: {
    agents: number;
    surfaces: number;
    doors: number;
    workflows: number;
    channels: number;
    toolFamilies: number;
    censusCells: number;
    censusExposed: number;
  };
  agents: MeshAgentView[];
  surfaces: MeshSurfaceEntry[];
  doors: MeshDoorView[];
  workflows: MeshWorkflowEntry[];
  /**
   * The platform capabilities (#3700) — shared Technology Platform
   * products, derived from the manifest module via
   * platformCapabilities(), never a hard-coded list in this view.
   */
  platformCapabilities: PlatformCapability[];
  channels: MeshChannelEntry[];
  toolFamilies: MeshToolFamilyEntry[];
  programme: {
    g12Proof: typeof MESH_G12_PROOF;
    skillsAssessment: typeof MESH_SKILLS_ASSESSMENT;
    traceSpine: MeshTraceSpineEntry[];
    /** The spine's recorded breaks only — the honest negatives. */
    traceBreaks: MeshTraceSpineEntry[];
    /** Every per-agent mesh credential env name across the identity
     * records (names only — the transitional shared fallback's name
     * is carried in each record's credentialPosture text). */
    credentialEnvNames: string[];
  };
}

/**
 * Build the Agents view payload from the registry module. Pure:
 * the same registry state always yields the same payload, and the
 * route calls it per request so the served data is the registry
 * as it stands in the deployed bundle.
 */
export function buildMeshRegistryView(): MeshRegistryView {
  const credentialEnvNames = [
    ...new Set(MESH_IDENTITIES.flatMap((r) => r.meshCredentials)),
  ].sort();
  return {
    source: "src/agents/registry.ts",
    counts: {
      agents: MESH_AGENTS.length,
      surfaces: MESH_SURFACES.length,
      doors: MESH_DOORS.length,
      workflows: MESH_WORKFLOWS.length,
      channels: MESH_CHANNELS.length,
      toolFamilies: MESH_TOOL_FAMILIES.length,
      censusCells: MESH_AGENTS.reduce(
        (n, a) => n + capabilityDoorsForClass(a.className).length,
        0,
      ),
      censusExposed: MESH_AGENTS.reduce(
        (n, a) =>
          n +
          capabilityDoorsForClass(a.className).filter(
            (c) => c.status === "exposed",
          ).length,
        0,
      ),
    },
    agents: MESH_AGENTS.map((entry) => ({
      ...entry,
      doors: capabilityDoorsForClass(entry.className),
      identity: getIdentityRecord(entry.className) ?? null,
      capabilities: capabilitiesForClass(entry.className),
    })),
    surfaces: [...MESH_SURFACES],
    doors: MESH_DOORS.map((door) => ({ ...door, budget: doorCostBudget(door.id) })),
    workflows: [...MESH_WORKFLOWS],
    platformCapabilities: platformCapabilities(),
    channels: [...MESH_CHANNELS],
    toolFamilies: [...MESH_TOOL_FAMILIES],
    programme: {
      g12Proof: MESH_G12_PROOF,
      skillsAssessment: MESH_SKILLS_ASSESSMENT,
      traceSpine: [...MESH_TRACE_SPINE],
      traceBreaks: MESH_TRACE_SPINE.filter((e) => e.status === "break"),
      credentialEnvNames,
    },
  };
}
