/**
 * Issue #1387 — Research Think turn can never bootstrap.
 *
 * The agents SDK resolves sub-agents through `ctx.exports`, keyed by the
 * parent's `constructor.name`: OrchestratorAgent's `runAgentTool` requires
 * `ctx.exports["OrchestratorAgent"]` to expose `idFromName`. This repo
 * originally exported the class ONLY as `SearchAgent` and bound ONLY
 * SEARCH_AGENT, so every Think dispatch from OrchestratorAgent threw the
 * SDK's "Sub-agent bootstrap requires the root agent class" error.
 *
 * Final state (#2523, Agent Mesh S2-B; gate record #2326): the two-deploy
 * G0 rename is complete. Migration v14 (#2330, Deploy A) tombstoned the
 * colliding v9 OrchestratorAgent namespace (deleted_classes), and
 * migration v15 renames the SEARCH_AGENT namespace onto OrchestratorAgent
 * (renamed_classes) — at that step the binding name was left unchanged,
 * its class_name became OrchestratorAgent, the SearchAgent export alias
 * was retired, and the own-name export was restored, so root resolution
 * works against the renamed namespace (whose instance names — logins —
 * and stored state carried over). The G0 rename did NOT re-add an
 * ORCHESTRATOR_AGENT binding: the class rename itself gave the class
 * its namespace back under the existing binding.
 *
 * Issue #2570 then finished the rename on the binding side: the ONE
 * binding was renamed SEARCH_AGENT → ORCHESTRATOR_AGENT (not a second
 * binding re-added). Namespaces are per class, not per binding name,
 * so no migration accompanies it and the pins below assert the
 * finished shape. This suite reads the entrypoint and wrangler.jsonc
 * as text (same idiom as tests/kv_bindings_removed.test.ts). The v9
 * and v14 migration entries stay in the append-only migrations array
 * as history.
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

const serverTs = readFileSync(resolve(root, "src/server.ts"), "utf8");
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

describe("OrchestratorAgent root namespace (issue #1387)", () => {
  it("server.ts exports OrchestratorAgent under its own name (restored by #2523)", () => {
    // The SDK looks the root class up in ctx.exports by constructor
    // name, so the own-name export must exist. Deploy A (#2330) removed
    // it temporarily (legacy Delete-migration procedure step 2) while
    // the v9 namespace was tombstoned; Deploy B restores it with the
    // rename. The retired alias line
    // `export { OrchestratorAgent as SearchAgent }` must NOT satisfy
    // this pattern (it names a different export).
    expect(serverTs).toMatch(
      /export\s*\{\s*OrchestratorAgent\s*(as\s+OrchestratorAgent\s*)?\}/
    );
  });

  it("the SearchAgent alias is retired and the binding (renamed by #2570) binds class_name OrchestratorAgent (#2523)", () => {
    expect(serverTs).not.toContain(
      "export { OrchestratorAgent as SearchAgent }"
    );
    expect(
      wrangler.durable_objects.bindings.some(
        (b) =>
          b.name === "ORCHESTRATOR_AGENT" &&
          b.class_name === "OrchestratorAgent"
      )
    ).toBe(true);
    expect(
      wrangler.durable_objects.bindings.some((b) => b.name === "SEARCH_AGENT")
    ).toBe(false);
  });

  it("migration v15 renames SearchAgent → OrchestratorAgent and is the last migration", () => {
    const v15 = wrangler.migrations.find((m) => m.tag === "v15");
    expect(v15).toBeDefined();
    expect(v15!.renamed_classes ?? []).toEqual([
      { from: "SearchAgent", to: "OrchestratorAgent" },
    ]);
    expect(wrangler.migrations[wrangler.migrations.length - 1].tag).toBe(
      "v15"
    );
  });

  it("exactly one binding names the OrchestratorAgent class (the #2570 rename, not a re-added second binding), and migration v14 still tombstones the v9 class (#2330 history)", () => {
    // Deploy B did not re-add a second binding — the class rename gave
    // the class its namespace back under the existing binding. #2570
    // later renamed that one binding itself, so exactly one binding
    // carries class_name OrchestratorAgent and it is ORCHESTRATOR_AGENT.
    expect(
      wrangler.durable_objects.bindings.filter(
        (b) => b.class_name === "OrchestratorAgent"
      )
    ).toEqual([{ name: "ORCHESTRATOR_AGENT", class_name: "OrchestratorAgent" }]);
    expect(
      wrangler.migrations.some(
        (m) =>
          m.tag === "v14" &&
          (m.deleted_classes ?? []).includes("OrchestratorAgent")
      )
    ).toBe(true);
  });

  it("a migration covers the new OrchestratorAgent sqlite class", () => {
    expect(
      wrangler.migrations.some((m) =>
        (m.new_sqlite_classes ?? []).includes("OrchestratorAgent")
      )
    ).toBe(true);
  });
});
