/**
 * Issue #2470 S3 — verify the supposedly unused DO bindings.
 *
 * The doc claimed ORCHESTRATOR_AGENT and SANDBOX_AGENT have no `env.`
 * call sites and consume nothing. Both claims were REFUTED against
 * main at the time, so neither binding was removed then:
 *
 * - SEARCH_AGENT: the merged #2465 cross-tenant slice fans out
 *   through it (adminTenantQueues instanceStub: idFromName + get on
 *   env.SEARCH_AGENT) — a live production path, not a declaration.
 *   The fan-out originally addressed via ORCHESTRATOR_AGENT; #2516
 *   repointed it to SEARCH_AGENT, where the per-login instances and
 *   their schedules/maintenance state actually live, so Deploy A of
 *   the G0 rename (#2330) can retire the ORCHESTRATOR_AGENT binding.
 *   That binding's remaining guard is the #1387 root-namespace pin
 *   (tests/orchestrator_root_namespace_1387.test.ts), not this file.
 *
 * Issue #2570 update: the SEARCH_AGENT binding itself has since been
 * renamed ORCHESTRATOR_AGENT — the same string the retired v9 binding
 * once used, now naming the one live binding (the v9 namespace stays
 * tombstoned by migration v14; namespaces are per class). The test
 * below pins the fan-out to the binding under its current name, and
 * the drift guard inverts accordingly: the fan-out must not drift
 * back to the retired SEARCH_AGENT name.
 * - SANDBOX_AGENT: the A2A edge resolves it DYNAMICALLY
 *   (a2a/index.ts reads env[resolution.binding], and resolution.ts
 *   maps the sandbox surface to SANDBOX_AGENT) — a grep for a
 *   literal `env.SANDBOX_AGENT` misses it, which is exactly how the
 *   doc's claim went wrong. The class export from the entrypoint
 *   and the conformance pins are secondary evidence.
 *
 * These tests pin the access paths so a future removal attempt fails
 * loudly instead of silently dropping a live binding.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const wrangler = readFileSync("wrangler.jsonc", "utf8");

describe("DO bindings verification (#2470 S3)", () => {
  it("ORCHESTRATOR_AGENT is bound and used by the merged cross-tenant fan-out (#2465, repointed by #2516; binding renamed by #2570)", () => {
    expect(wrangler).toMatch(/"name":\s*"ORCHESTRATOR_AGENT",\s*"class_name":\s*"OrchestratorAgent"/);
    const queues = readFileSync("src/agents/routes/adminTenantQueues.ts", "utf8");
    expect(queues).toContain("ORCHESTRATOR_AGENT");
    expect(queues).toContain("idFromName");
    // instanceStub resolves the target instance through the binding.
    expect(queues).toMatch(/ORCHESTRATOR_AGENT[\s\S]*?idFromName[\s\S]*?\.get\(/);
    // The fan-out must not drift back to the retired SEARCH_AGENT
    // binding name (#2570): the per-login instances live in the
    // OrchestratorAgent namespace, reached through the one binding
    // now named ORCHESTRATOR_AGENT.
    expect(queues).not.toContain("SEARCH_AGENT");
  });

  it("SANDBOX_AGENT is bound and reached through the A2A dynamic binding lookup", () => {
    expect(wrangler).toMatch(/"name":\s*"SANDBOX_AGENT",\s*"class_name":\s*"SandboxAgent"/);
    const resolution = readFileSync("src/a2a/resolution.ts", "utf8");
    expect(resolution).toContain('sandbox: { binding: "SANDBOX_AGENT" }');
    const edge = readFileSync("src/a2a/index.ts", "utf8");
    // Dynamic access: no literal env.SANDBOX_AGENT exists, which is
    // why the doc's static call-site search missed this path.
    expect(edge).toMatch(/\(env as any\)\[resolution\.binding\]/);
    // Slice 9 of #2902 moves the exports to src/server/exports.ts;
    // server.ts re-exports them. The live export surface is both files.
    const server = readFileSync("src/server.ts", "utf8") + readFileSync("src/server/exports.ts", "utf8");
    // Slice 9 of #2902: the export moved one directory deeper
    // (src/server/exports.ts), so the relative path is now ../ —
    // the module is the same; the pattern accepts either spelling.
    expect(server).toMatch(/export \{ SandboxAgent \} from "\.{1,2}\/agents\/sandbox-agent"/);
  });
});
