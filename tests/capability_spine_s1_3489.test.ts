/**
 * Issue #3489 (Uniform Copilot Standard S1, epic #3488) — the
 * PortThink capability spine.
 *
 * The standard (owner doctrine, 2026-11-06): any copilot invocable
 * through any channel, every capability enabled through externalized
 * configuration (AOP). This suite pins the spine that makes that a
 * checkable property of the fleet:
 *
 *  - the typed manifest: three families (channels × runtime
 *    capabilities × tools), every entry one of enabled /
 *    disabled-by-config / unavailable / not-implemented;
 *  - TRUTHFUL states, derived from the pinned SDK surface
 *    (agents 0.32.0 / @cloudflare/think 0.23.0) and repo evidence —
 *    the pins below record reality (email not-implemented
 *    fleet-wide until S2; voice not-implemented fleet-wide except
 *    OrchestratorAgent since S3 (#3720); the sandbox unavailable until a
 *    container backend is configured; webhooks enabled at the port
 *    since #3474 but unavailable in any env without
 *    THINK_WEBHOOK_SECRET), never the docs' aspirations;
 *  - resolution from externalized config (AOP, #2419 idiom):
 *    doctrine defaults (enabled unless explicitly disabled),
 *    per-agent overrides keyed by class or binding name, config
 *    never enables what code does not implement, malformed config
 *    surfaces as recorded issues and never throws;
 *  - fleet conformance: every PortThink subclass in the class
 *    inventory (MESH_AGENTS, cross-checked against a source scan)
 *    carries an explicit capability record and resolves a complete
 *    manifest — a future class without a record fails here;
 *  - registry surfacing: the manifest joins the S20 Agents view
 *    payload additively (capabilitiesForClass + MeshAgentView).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AGENT_CAPABILITIES_DISABLED_ENV,
  ALL_CAPABILITY_IDS,
  CAPABILITY_CHANNELS,
  CAPABILITY_RUNTIME,
  CAPABILITY_TOOLS,
  hasExplicitCapabilityRecord,
  parseCapabilityDisabledList,
  resolveAgentCapabilityManifest,
  type CapabilityState,
} from "../src/actors/capabilityManifest";
import {
  MESH_AGENTS,
  capabilitiesForClass,
} from "../src/agents/registry";
import { buildMeshRegistryView } from "../src/services/meshRegistryView";

const ROOT = path.resolve(__dirname, "..");

const STATES: CapabilityState[] = [
  "enabled",
  "disabled-by-config",
  "unavailable",
  "not-implemented",
];

const PORT_THINK_CLASSES = MESH_AGENTS.filter((a) => a.base === "PortThink").map(
  (a) => a.className,
);

function* walkTs(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

// ---------------------------------------------------------------------------
// The family catalogs
// ---------------------------------------------------------------------------

describe("capability family catalogs (#3489)", () => {
  it("channels are exactly the five Agents-docs communication channels", () => {
    expect([...CAPABILITY_CHANNELS]).toEqual([
      "chat",
      "webhooks",
      "email",
      "slack",
      "voice",
    ]);
  });

  it("runtime capabilities are exactly the five from the standard", () => {
    expect([...CAPABILITY_RUNTIME]).toEqual([
      "mcpClient",
      "scheduler",
      "state",
      "lifecycle",
      "webSockets",
    ]);
  });

  it("tools are exactly the eight from the standard's second wave", () => {
    expect([...CAPABILITY_TOOLS]).toEqual([
      "workspace",
      "sandbox",
      "browser",
      "webFetch",
      "webSearch",
      "aiSearch",
      "payments",
      "observability",
    ]);
  });

  it("the flat id list is the union, with no duplicates", () => {
    expect(ALL_CAPABILITY_IDS).toHaveLength(18);
    expect(new Set(ALL_CAPABILITY_IDS).size).toBe(18);
  });

  it("the externalized config var is named in the #2419 style", () => {
    expect(AGENT_CAPABILITIES_DISABLED_ENV).toBe("AGENT_CAPABILITIES_DISABLED");
  });
});

// ---------------------------------------------------------------------------
// Resolution — doctrine defaults and truthful states
// ---------------------------------------------------------------------------

describe("capability resolution: truthful defaults (#3489)", () => {
  it("OrchestratorAgent: the wired surface reports enabled, the gaps report not-implemented", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent");
    expect(m.className).toBe("OrchestratorAgent");
    expect(m.channels.chat.state).toBe("enabled");
    expect(m.channels.webhooks.state).toBe("enabled");
    expect(m.channels.webhooks.prerequisite).toBe("THINK_WEBHOOK_SECRET");
    expect(m.channels.slack.state).toBe("enabled");
    expect(m.channels.email.state).toBe("not-implemented");
    expect(m.channels.voice.state).toBe("enabled");
    expect(m.capabilities.mcpClient.state).toBe("enabled");
    expect(m.capabilities.scheduler.state).toBe("enabled");
    expect(m.capabilities.state.state).toBe("enabled");
    expect(m.capabilities.lifecycle.state).toBe("enabled");
    expect(m.capabilities.webSockets.state).toBe("enabled");
    expect(m.tools.workspace.state).toBe("enabled");
    expect(m.tools.webFetch.state).toBe("enabled");
    expect(m.tools.webSearch.state).toBe("enabled");
    expect(m.tools.webSearch.prerequisite).toBe("BRAVE_SEARCH_API_KEY");
    expect(m.tools.payments.state).toBe("enabled");
    expect(m.tools.sandbox.state).toBe("not-implemented");
    expect(m.tools.browser.state).toBe("not-implemented");
    expect(m.tools.aiSearch.state).toBe("not-implemented");
    expect(m.tools.observability.state).toBe("not-implemented");
    expect(m.configIssues).toEqual([]);
  });

  it("a non-orchestrator class gets the fleet defaults: substrate enabled, unwired surface not-implemented", () => {
    const m = resolveAgentCapabilityManifest("ResearchAgent");
    expect(m.channels.chat.state).toBe("not-implemented");
    expect(m.channels.webhooks.state).toBe("enabled");
    expect(m.channels.slack.state).toBe("not-implemented");
    expect(m.capabilities.mcpClient.state).toBe("not-implemented");
    expect(m.capabilities.scheduler.state).toBe("enabled");
    expect(m.capabilities.state.state).toBe("enabled");
    expect(m.capabilities.lifecycle.state).toBe("enabled");
    expect(m.capabilities.webSockets.state).toBe("enabled");
    expect(m.tools.workspace.state).toBe("enabled");
    expect(m.tools.webFetch.state).toBe("not-implemented");
    expect(m.tools.webSearch.state).toBe("not-implemented");
    expect(m.tools.payments.state).toBe("not-implemented");
  });

  it("email is not-implemented for EVERY PortThink class (S2 has not landed); voice is enabled only on OrchestratorAgent (S3, #3720)", () => {
    for (const className of PORT_THINK_CLASSES) {
      const m = resolveAgentCapabilityManifest(className);
      expect(m.channels.email.state, className).toBe("not-implemented");
      expect(m.channels.voice.state, className).toBe(
        className === "OrchestratorAgent" ? "enabled" : "not-implemented"
      );
    }
  });

  it("the class-specific tool postures are recorded truthfully", () => {
    const sandbox = resolveAgentCapabilityManifest("SandboxAgent");
    expect(sandbox.tools.sandbox.state).toBe("unavailable");
    expect(sandbox.tools.sandbox.unavailableReason).toContain("container");

    const aiSearch = resolveAgentCapabilityManifest("AiSearchAgent");
    expect(aiSearch.tools.aiSearch.state).toBe("enabled");

    const browser = resolveAgentCapabilityManifest("BrowserAgent");
    expect(browser.tools.browser.state).toBe("enabled");

    const payments = resolveAgentCapabilityManifest("PaymentsAgent");
    expect(payments.tools.payments.state).toBe("enabled");

    const slack = resolveAgentCapabilityManifest("SlackAgent");
    expect(slack.channels.slack.state).toBe("enabled");
  });

  it("every entry carries an evidence note; unavailable entries carry a named reason", () => {
    for (const className of PORT_THINK_CLASSES) {
      const m = resolveAgentCapabilityManifest(className);
      const entries = [
        ...Object.values(m.channels),
        ...Object.values(m.capabilities),
        ...Object.values(m.tools),
      ];
      for (const entry of entries) {
        expect(entry.note.length, className).toBeGreaterThan(0);
        if (entry.state === "unavailable") {
          expect(entry.unavailableReason, className).toBeTruthy();
        }
      }
    }
  });

  it("an unknown class still resolves a complete default manifest (resolution never throws)", () => {
    const m = resolveAgentCapabilityManifest("FutureAgent");
    expect(Object.keys(m.channels).sort()).toEqual([...CAPABILITY_CHANNELS].sort());
    expect(Object.keys(m.capabilities).sort()).toEqual([...CAPABILITY_RUNTIME].sort());
    expect(Object.keys(m.tools).sort()).toEqual([...CAPABILITY_TOOLS].sort());
  });
});

// ---------------------------------------------------------------------------
// Resolution — deployment prerequisites (env evaluated only when given)
// ---------------------------------------------------------------------------

describe("capability resolution: prerequisites (#3489)", () => {
  it("without an env, prerequisites are recorded but not evaluated", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent");
    expect(m.channels.webhooks.state).toBe("enabled");
    expect(m.tools.webSearch.state).toBe("enabled");
  });

  it("an env without THINK_WEBHOOK_SECRET makes webhooks unavailable with the port's named reason", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", { env: {} });
    expect(m.channels.webhooks.state).toBe("unavailable");
    expect(m.channels.webhooks.unavailableReason).toBe("webhook_secret_not_configured");
  });

  it("a blank THINK_WEBHOOK_SECRET is unconfigured (the #3474 resolver's rule)", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      env: { THINK_WEBHOOK_SECRET: "   " },
    });
    expect(m.channels.webhooks.state).toBe("unavailable");
  });

  it("an env without BRAVE_SEARCH_API_KEY makes web_search unavailable with the service's named error", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", { env: {} });
    expect(m.tools.webSearch.state).toBe("unavailable");
    expect(m.tools.webSearch.unavailableReason).toBe("web_search_provider_not_configured");
  });

  it("an env with both secrets keeps both capabilities enabled", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      env: { THINK_WEBHOOK_SECRET: "s3cret", BRAVE_SEARCH_API_KEY: "key" },
    });
    expect(m.channels.webhooks.state).toBe("enabled");
    expect(m.tools.webSearch.state).toBe("enabled");
  });
});

// ---------------------------------------------------------------------------
// Resolution — externalized config overrides (AOP)
// ---------------------------------------------------------------------------

describe("capability resolution: AGENT_CAPABILITIES_DISABLED (#3489)", () => {
  const ENV_WITH_SECRETS = { THINK_WEBHOOK_SECRET: "s", BRAVE_SEARCH_API_KEY: "k" };

  it("a class-scoped entry disables exactly that capability for that class", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      env: ENV_WITH_SECRETS,
      disabledRaw: "OrchestratorAgent:webSearch",
    });
    expect(m.tools.webSearch.state).toBe("disabled-by-config");
    expect(m.tools.webSearch.disabledBy).toBe("OrchestratorAgent:webSearch");
    expect(m.tools.webFetch.state).toBe("enabled");
    expect(m.configIssues).toEqual([]);
  });

  it("a wildcard entry disables the capability for every class", () => {
    const m = resolveAgentCapabilityManifest("ResearchAgent", {
      disabledRaw: "*:lifecycle",
    });
    expect(m.capabilities.lifecycle.state).toBe("disabled-by-config");
  });

  it("a binding-scoped entry matches through the class's bindings", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      bindings: ["ORCHESTRATOR_AGENT"],
      disabledRaw: "ORCHESTRATOR_AGENT:chat",
    });
    expect(m.channels.chat.state).toBe("disabled-by-config");
  });

  it("a non-matching scope changes nothing", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      disabledRaw: "TradingAgent:chat",
    });
    expect(m.channels.chat.state).toBe("enabled");
  });

  it("config never enables or re-enables: disabling a not-implemented capability is a no-op", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      disabledRaw: "*:email",
    });
    expect(m.channels.email.state).toBe("not-implemented");
    expect(m.configIssues).toEqual([]);
  });

  it("a deployment fact wins over config: unavailable stays unavailable when also disabled", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      env: {},
      disabledRaw: "*:webhooks",
    });
    expect(m.channels.webhooks.state).toBe("unavailable");
  });

  it("the override list is read from env when no explicit value is passed", () => {
    const m = resolveAgentCapabilityManifest("ResearchAgent", {
      env: { AGENT_CAPABILITIES_DISABLED: "*:state" },
    });
    expect(m.capabilities.state.state).toBe("disabled-by-config");
  });

  it("malformed entries are recorded as config issues and never thrown", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent", {
      disabledRaw: "nocolon, OrchestratorAgent:bogus, :chat, OrchestratorAgent:chat",
    });
    expect(m.channels.chat.state).toBe("disabled-by-config");
    expect(m.configIssues).toHaveLength(3);
  });

  it("parseCapabilityDisabledList separates entries from issues", () => {
    const { entries, issues } = parseCapabilityDisabledList(
      "OrchestratorAgent:chat, *:voice , bad",
    );
    expect(entries).toEqual([
      { scope: "OrchestratorAgent", capability: "chat" },
      { scope: "*", capability: "voice" },
    ]);
    expect(issues).toHaveLength(1);
  });

  it("an empty or absent override value parses to no entries and no issues", () => {
    expect(parseCapabilityDisabledList(undefined)).toEqual({ entries: [], issues: [] });
    expect(parseCapabilityDisabledList("")).toEqual({ entries: [], issues: [] });
    expect(parseCapabilityDisabledList("   ")).toEqual({ entries: [], issues: [] });
  });
});

// ---------------------------------------------------------------------------
// Fleet conformance — the class inventory carries complete manifests
// ---------------------------------------------------------------------------

describe("fleet conformance (#3489)", () => {
  it("the inventory's PortThink set equals the source scan (a new class cannot slip in unregistered)", () => {
    const declared = new Set<string>();
    for (const file of walkTs(path.join(ROOT, "src"))) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/export\s+class\s+(\w+)\s+extends\s+PortThink\b/g)) {
        declared.add(m[1]);
      }
    }
    expect([...declared].sort()).toEqual([...PORT_THINK_CLASSES].sort());
  });

  it("every PortThink class in the inventory has an EXPLICIT capability record", () => {
    for (const className of PORT_THINK_CLASSES) {
      expect(hasExplicitCapabilityRecord(className), className).toBe(true);
    }
    expect(hasExplicitCapabilityRecord("FutureAgent")).toBe(false);
  });

  it("every PortThink class resolves a complete manifest: all 18 ids, valid states", () => {
    for (const className of PORT_THINK_CLASSES) {
      const m = resolveAgentCapabilityManifest(className);
      expect(Object.keys(m.channels).sort(), className).toEqual(
        [...CAPABILITY_CHANNELS].sort(),
      );
      expect(Object.keys(m.capabilities).sort(), className).toEqual(
        [...CAPABILITY_RUNTIME].sort(),
      );
      expect(Object.keys(m.tools).sort(), className).toEqual([...CAPABILITY_TOOLS].sort());
      const entries = [
        ...Object.values(m.channels),
        ...Object.values(m.capabilities),
        ...Object.values(m.tools),
      ];
      for (const entry of entries) {
        expect(STATES, className).toContain(entry.state);
      }
    }
  });

  it("resolution survives a hostile config for every class (never throws)", () => {
    for (const className of PORT_THINK_CLASSES) {
      const m = resolveAgentCapabilityManifest(className, {
        env: {},
        disabledRaw: "*:chat,*:bogus,garbage,*:webhooks",
      });
      expect(m.className).toBe(className);
      expect(m.configIssues.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry surfacing — the S20 Agents view data path
// ---------------------------------------------------------------------------

describe("registry surfacing (#3489)", () => {
  it("capabilitiesForClass resolves a manifest for PortThink entries only", () => {
    const m = capabilitiesForClass("OrchestratorAgent");
    expect(m).not.toBeNull();
    expect(m!.className).toBe("OrchestratorAgent");
    expect(m!.bindings).toEqual(["ORCHESTRATOR_AGENT"]);
    expect(capabilitiesForClass("SessionStore")).toBeNull();
    expect(capabilitiesForClass("OptionsScannerMCP")).toBeNull();
    expect(capabilitiesForClass("NoSuchAgent")).toBeNull();
  });

  it("the Agents view payload carries each PortThink entry's manifest, additively", () => {
    const view = buildMeshRegistryView();
    for (const agentView of view.agents) {
      const entry = MESH_AGENTS.find((a) => a.className === agentView.className)!;
      if (entry.base === "PortThink") {
        expect(agentView.capabilities, agentView.className).not.toBeNull();
        expect(agentView.capabilities).toEqual(capabilitiesForClass(agentView.className));
      } else {
        expect(agentView.capabilities, agentView.className).toBeNull();
      }
    }
  });
});
