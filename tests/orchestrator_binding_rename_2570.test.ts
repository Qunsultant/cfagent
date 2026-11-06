/**
 * Issue #2570 — finish the OrchestratorAgent rename on the binding side.
 *
 * Migration v14 (#2330) + v15 (#2523) renamed the CLASS SearchAgent →
 * OrchestratorAgent but deliberately left the Durable Object BINDING
 * named SEARCH_AGENT. The Agents SDK's routeAgentRequest builds its
 * namespace map from binding names kebab-cased, so the copilot chat
 * route is /agents/search-agent/ and the client cannot address the
 * agent by its class name. This suite pins the finished shape:
 *
 * - wrangler.jsonc binds ORCHESTRATOR_AGENT → OrchestratorAgent and no
 *   SEARCH_AGENT binding exists;
 * - the append-only migrations array is UNCHANGED (v1 … v15, v15 last):
 *   namespaces are per class, not per binding name, so the rename
 *   needs no migration and per-login instances/state carry over;
 * - src/types.ts declares exactly one ORCHESTRATOR_AGENT binding —
 *   required — and no SEARCH_AGENT declaration (the stale optional
 *   #1387 ORCHESTRATOR_AGENT declaration is gone);
 * - no live code-shape reference to the old binding name remains in
 *   src/ (env reads, property accesses, string literals, type keys);
 * - the chat client addresses the agent as "OrchestratorAgent", whose
 *   kebab form (orchestrator-agent) is now a real binding route.
 *
 * Historical prose may still name SEARCH_AGENT where it explicitly
 * records the pre-rename state (e.g. the registry's G0 narrative);
 * this suite pins code shape, not history.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
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

const wrangler = JSON.parse(
  stripJsonc(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"))
) as {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{
    tag: string;
    new_sqlite_classes?: string[];
    deleted_classes?: string[];
    renamed_classes?: Array<{ from: string; to: string }>;
  }>;
};

const typesTs = readFileSync(resolve(root, "src/types.ts"), "utf8");

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("OrchestratorAgent binding rename (issue #2570)", () => {
  it("wrangler binds ORCHESTRATOR_AGENT to OrchestratorAgent and no SEARCH_AGENT binding exists", () => {
    const orch = wrangler.durable_objects.bindings.filter(
      (b) => b.class_name === "OrchestratorAgent"
    );
    expect(orch).toEqual([
      { name: "ORCHESTRATOR_AGENT", class_name: "OrchestratorAgent" },
    ]);
    expect(
      wrangler.durable_objects.bindings.some((b) => b.name === "SEARCH_AGENT")
    ).toBe(false);
  });

  it("the migrations array is unchanged history: v1 SearchAgent, v14 tombstone, v15 rename, v15 last (no new migration)", () => {
    const tags = wrangler.migrations.map((m) => m.tag);
    expect(tags[tags.length - 1]).toBe("v15");
    const v1 = wrangler.migrations.find((m) => m.tag === "v1");
    expect(v1!.new_sqlite_classes ?? []).toEqual(["SearchAgent"]);
    const v14 = wrangler.migrations.find((m) => m.tag === "v14");
    expect(v14!.deleted_classes ?? []).toEqual(["OrchestratorAgent"]);
    const v15 = wrangler.migrations.find((m) => m.tag === "v15");
    expect(v15!.renamed_classes ?? []).toEqual([
      { from: "SearchAgent", to: "OrchestratorAgent" },
    ]);
  });

  it("types.ts declares exactly one required ORCHESTRATOR_AGENT and no SEARCH_AGENT", () => {
    expect(typesTs).toMatch(/^\s*ORCHESTRATOR_AGENT: DurableObjectNamespace;/m);
    expect(typesTs).not.toMatch(/ORCHESTRATOR_AGENT\?:/);
    expect(typesTs).not.toMatch(/\bSEARCH_AGENT\b/);
    const decls = typesTs.match(/\bORCHESTRATOR_AGENT\b/g) ?? [];
    // One declaration plus at most comment mentions; the binding field
    // itself must appear exactly once as a declaration.
    expect(
      typesTs.match(/ORCHESTRATOR_AGENT\??: DurableObjectNamespace/g) ?? []
    ).toHaveLength(1);
    expect(decls.length).toBeGreaterThanOrEqual(1);
  });

  it("no live code-shape reference to SEARCH_AGENT remains anywhere in src/", () => {
    const codeShapes: Array<[string, RegExp]> = [
      ["env read", /env\.SEARCH_AGENT\b/],
      ["property access", /\.SEARCH_AGENT\b/],
      ["double-quoted literal", /"SEARCH_AGENT"/],
      ["single-quoted literal", /'SEARCH_AGENT'/],
      ["optional type key", /\bSEARCH_AGENT\?:/],
      ["object/type key", /\bSEARCH_AGENT:/],
    ];
    const offenders: string[] = [];
    for (const file of srcFiles(resolve(root, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const [shape, re] of codeShapes) {
        if (re.test(text)) {
          offenders.push(
            `${file.replace(root + "/", "")} (${shape})`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the chat client addresses the agent as OrchestratorAgent, which kebabs to the renamed binding's route", () => {
    const chatTab = readFileSync(
      resolve(root, "src/client/chat/AgentChatTabContent.tsx"),
      "utf8"
    );
    expect(chatTab).toContain('agent: "OrchestratorAgent"');
    const kebab = (name: string) =>
      name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/_/g, "-")
        .toLowerCase();
    const routes = new Set(
      wrangler.durable_objects.bindings.map((b) => kebab(b.name))
    );
    expect(routes.has("orchestrator-agent")).toBe(true);
    expect(routes.has("search-agent")).toBe(false);
  });
});
