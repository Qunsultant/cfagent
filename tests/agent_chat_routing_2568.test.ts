/**
 * Issue #2568 — Copilot chat must address an existing Durable Object
 * binding, not a class name.
 *
 * Production failure (2026-10-31): GET /agents/orchestrator-agent/<login>
 * returned "does not match any Durable Object binding", because Agents
 * SDK routeAgentRequest builds its namespace map from env BINDING names
 * kebabbed, not from class names. wrangler.jsonc binds only
 * SEARCH_AGENT (class OrchestratorAgent since migration v15, #2523);
 * there is no ORCHESTRATOR_AGENT binding, and the chat tab passed
 * "OrchestratorAgent" to useAgent, which kebabs to orchestrator-agent.
 *
 * This suite pins the fix by reading wrangler.jsonc and the chat tab
 * as text (same idiom as tests/orchestrator_root_namespace_1387.test.ts):
 * the agent string passed to useAgent in the chat tab, kebab-cased,
 * must be one of the kebab-cased wrangler DO binding names, and
 * specifically search-agent, while SEARCH_AGENT's class is
 * OrchestratorAgent. Instance name (login) and DO state are unchanged
 * by the fix: same SEARCH_AGENT namespace, same idFromName(login).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

const wrangler = JSON.parse(
  stripJsonc(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"))
) as {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
};
const chatTab = readFileSync(
  resolve(root, "src/client/chat/AgentChatTabContent.tsx"),
  "utf8"
);

function chatUseAgentName(): string {
  const m = chatTab.match(/useAgent\(\{\s*agent:\s*"([^"]+)"/);
  expect(m, "chat tab must call useAgent with a literal agent name").not.toBeNull();
  return m![1];
}

describe("Copilot chat agent routing (issue #2568)", () => {
  it("the chat tab's useAgent agent kebabs to an existing DO binding name", () => {
    const bindingRoutes = new Set(
      wrangler.durable_objects.bindings.map((b) => kebab(b.name))
    );
    expect(kebab(chatUseAgentName())).toBe("search-agent");
    expect(bindingRoutes.has(kebab(chatUseAgentName()))).toBe(true);
    expect(bindingRoutes.has("orchestrator-agent")).toBe(false);
  });

  it("SEARCH_AGENT is bound to class OrchestratorAgent (migration v15), so the route and the class agree", () => {
    const binding = wrangler.durable_objects.bindings.find(
      (b) => b.name === "SEARCH_AGENT"
    );
    expect(binding).toBeDefined();
    expect(binding!.class_name).toBe("OrchestratorAgent");
  });

  it("the chat tab does not pass OrchestratorAgent to useAgent (the comment explaining the old route is allowed)", () => {
    expect(chatTab).not.toContain('agent: "OrchestratorAgent"');
  });
});
