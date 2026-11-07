/**
 * Issue #3727 — copilot capability enablement conformance pin.
 *
 * Owner direction (2026-11-07): every capability-gating variable
 * of the AGENT_CAPABILITIES_DISABLED kind is externalized in
 * wrangler.jsonc vars AND set so the copilots are fully
 * functional/enabled — no constraints, none at all.
 *
 * The production-shaped env is wrangler.jsonc's vars block,
 * parsed here with the #2000 stripJsonc idiom. Against it:
 *  (a) the OrchestratorAgent manifest resolves with NOTHING
 *      disabled-by-config and no config issues —
 *      AGENT_CAPABILITIES_DISABLED is present and parses to
 *      zero entries; every capability the class's base record
 *      declares enabled (its mechanisms) resolves "enabled"
 *      (a prerequisite-gated entry may resolve "unavailable"
 *      only through its named prerequisite — a provider
 *      secret, never through the disabled list);
 *  (b) CHAT_NLQ_MODE resolves "on" at the env level and the
 *      Think-layer gate does not exclude the discovered NLQ
 *      tool from a chat turn's usable set;
 *  (c) SCREENER_ND_MODE resolves enabled at the mesh doors.
 *
 * A future silent constraint — a var removed, a value flipped,
 * a disabled entry added — fails this suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_CAPABILITIES_DISABLED_ENV,
  PORT_THINK_CAPABILITY_BASE,
  parseCapabilityDisabledList,
  resolveAgentCapabilityManifest,
  type CapabilityEntry,
} from "../src/actors/capabilityManifest";
import {
  OPENAIMP_NLQ_TOOL_KEY,
  chatNlqTurnGate,
} from "../src/agents/orchestrator/meshMcpClient";
import { resolveChatNlqTurnMode } from "../src/config/chatNlqModes";
import { resolveScreenerNdGateFromEnv } from "../src/config/screenerModes";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";

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
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** The production-shaped env: wrangler.jsonc's vars, verbatim. */
function productionEnv(): Record<string, unknown> {
  const wrangler = JSON.parse(
    stripJsonc(readFileSync("wrangler.jsonc", "utf8")),
  ) as { vars?: Record<string, unknown> };
  return { ...(wrangler.vars ?? {}) };
}

describe("copilot capability enablement (#3727)", () => {
  it("AGENT_CAPABILITIES_DISABLED is externalized in wrangler vars and parses to zero entries", () => {
    const env = productionEnv();
    expect(
      Object.prototype.hasOwnProperty.call(env, AGENT_CAPABILITIES_DISABLED_ENV),
    ).toBe(true);
    const { entries, issues } = parseCapabilityDisabledList(
      env[AGENT_CAPABILITIES_DISABLED_ENV] as string | undefined,
    );
    expect(issues).toEqual([]);
    expect(entries).toEqual([]);
  });

  it("the OrchestratorAgent manifest under the production env has nothing disabled and every mechanism-backed capability enabled", () => {
    const env = productionEnv();
    const manifest = resolveAgentCapabilityManifest("OrchestratorAgent", { env });
    expect(manifest.configIssues).toEqual([]);
    const resolved: Record<string, CapabilityEntry> = {
      ...manifest.channels,
      ...manifest.capabilities,
      ...manifest.tools,
    };
    for (const [id, e] of Object.entries(resolved)) {
      expect(e.state, `${id} must not be disabled-by-config`).not.toBe(
        "disabled-by-config",
      );
    }
    // Every capability the class's base record declares enabled —
    // i.e. declares with a mechanism — resolves enabled under the
    // production env. The one exception shape is a prerequisite-
    // gated entry (webSearch → BRAVE_SEARCH_API_KEY, a provider
    // secret set outside vars): it may resolve "unavailable"
    // through that named prerequisite, never disabled-by-config
    // (asserted above).
    const base = PORT_THINK_CAPABILITY_BASE["OrchestratorAgent"] ?? {};
    for (const [id, e] of Object.entries(base)) {
      if (!e || e.state !== "enabled") continue;
      if (e.prerequisite) continue;
      expect(resolved[id]?.state, `${id} must resolve enabled`).toBe("enabled");
    }
  });

  it("CHAT_NLQ_MODE resolves on from the production env and the gate keeps the NLQ tool usable", () => {
    const env = productionEnv();
    const resolved = resolveChatNlqTurnMode({ env });
    expect(resolved.invalid).toBe(false);
    expect(resolved.level).toBe("env");
    expect(resolved.mode).toBe("on");
    const audits: Array<{ type: string }> = [];
    const gate = chatNlqTurnGate({
      toolNames: [OPENAIMP_NLQ_TOOL_KEY, "tool_openaimp_run_stock_screen"],
      context: { env },
      audit: (type) => {
        audits.push({ type });
      },
    });
    // No restriction: the NLQ tool stays in the turn's usable set,
    // and the gate reports the same resolved value the steering
    // follows (chatPrompt truth-sync, #3727).
    expect(gate.activeTools).toBeUndefined();
    expect(gate.mode).toBe("on");
    expect(audits).toEqual([]);
  });

  it("SCREENER_ND_MODE resolves enabled from the production env", () => {
    const gate = resolveScreenerNdGateFromEnv(productionEnv());
    expect(gate.invalid).toBe(false);
    expect(gate.enabled).toBe(true);
  });

  it("the prompt steering tells the resolved truth: enabled line when the gate is on, the flagged-off line only by default", () => {
    const baseInput = {
      route: { agent: "orchestrator", confidence: 1, reason: "pin" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    };
    const enabledPrompt = buildOrchestratorSystemPrompt({
      ...baseInput,
      chatNlqEnabled: true,
    });
    expect(enabledPrompt).not.toContain("Flagged OFF in chat turns");
    expect(enabledPrompt).toContain(
      "'tool_openaimp_execute_nlq': (Enabled in chat turns by CHAT_NLQ_MODE)",
    );
    // Default (no resolved value supplied): byte-identical to the
    // pre-#3727 prompt — the fixtures' contract.
    const defaultPrompt = buildOrchestratorSystemPrompt(baseInput);
    expect(defaultPrompt).toContain(
      "'tool_openaimp_execute_nlq': (Flagged OFF in chat turns by CHAT_NLQ_MODE, default off",
    );
  });
});
